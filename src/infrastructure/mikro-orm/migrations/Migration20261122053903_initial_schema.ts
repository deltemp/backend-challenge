import { Migration } from "@mikro-orm/migrations";

// Initial schema: wallets, the double-entry ledger, wagering transactions, inbox and outbox.
//
// The database enforces the invariants on its own, whatever the application does:
//
// - row rules are CHECK constraints: amounts, balances, states, failure codes, references;
// - uniqueness is a unique constraint or a partial unique index: one wallet per player and
//   currency, idempotency keys, provider ids, one OPENING per wallet, one ledger entry per
//   transaction, one entry per wallet version, one applied reversal per transaction;
// - foreign keys are composite where the currency must match, and deferred to the commit, so
//   rows of one unit of work may be written in any order. None points at a counter-account: a
//   foreign-key check locks the referenced row (FOR KEY SHARE) at every commit, and a provider's
//   settlement account is shared by all its wallets. Accounts never change, and the deferred
//   check below reads the counter-account of every entry without locking it;
// - guard triggers keep the ledger and its accounts insert-only, freeze decided transactions and
//   wallet identity, and keep an unpublished event from being lost;
// - deferred constraint triggers check at commit that balances, ledger entries and transactions
//   agree with each other: every balance change has its entry and every entry its applied
//   transaction, the entries of a wallet form an unbroken chain from zero, and the wallet holds
//   the balance its ledger ends at. `wallet.balance == balance rebuilt from the ledger` is
//   therefore a schema guarantee, not only a test assertion.
//
// Guard violations raise SQLSTATE 23000 and consistency violations 23514, each naming the rule
// in the error's `constraint` field. Messages carry ids and versions, never amounts: they reach
// the logs. Amounts, when useful, go to DETAIL, which the log serializer drops.

const TABLES = [
  `create table wallets (
    id uuid not null,
    player_id text not null,
    currency char(3) not null,
    balance numeric(20,2) not null,
    version integer not null,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    constraint wallets_pkey primary key (id),
    constraint wallets_player_id_currency_unique unique (player_id, currency),
    constraint wallets_id_currency_unique unique (id, currency),
    constraint wallets_player_id_check check (char_length(player_id) between 1 and 128),
    constraint wallets_currency_check check (currency ~ '^[A-Z]{3}$'),
    constraint wallets_balance_check check (balance >= 0),
    constraint wallets_version_check check (version >= 1)
  )`,
  `comment on table wallets is 'A player''s balance in one currency. version starts at 1 and advances by one with each ledger entry.'`,

  `create table ledger_accounts (
    id uuid not null,
    type text not null,
    currency char(3) not null,
    wallet_id uuid null,
    provider_id text null,
    created_at timestamptz not null,
    constraint ledger_accounts_pkey primary key (id),
    constraint ledger_accounts_type_check check (type in ('PLAYER_WALLET', 'PROVIDER_SETTLEMENT', 'FUNDING')),
    constraint ledger_accounts_currency_check check (currency ~ '^[A-Z]{3}$'),
    constraint ledger_accounts_provider_id_check check (char_length(provider_id) between 1 and 64),
    constraint ledger_accounts_owner_check check (
      (type = 'PLAYER_WALLET' and wallet_id is not null and wallet_id = id and provider_id is null)
      or (type = 'PROVIDER_SETTLEMENT' and wallet_id is null and provider_id is not null)
      or (type = 'FUNDING' and wallet_id is null and provider_id is null)
    ),
    constraint ledger_accounts_wallet_fkey foreign key (wallet_id, currency)
      references wallets (id, currency) deferrable initially deferred
  )`,
  `comment on table ledger_accounts is 'Accounts of the double-entry ledger, insert-only. A wallet''s account shares its id. No balance column and no foreign key pointing here from the ledger: counter-account balances are summed from entries, so no row is updated or locked by every wallet.'`,
  `create unique index ledger_accounts_provider_settlement_unique
    on ledger_accounts (provider_id, currency) where type = 'PROVIDER_SETTLEMENT'`,
  `create unique index ledger_accounts_funding_unique
    on ledger_accounts (currency) where type = 'FUNDING'`,

  `create table wager_transactions (
    id uuid not null,
    provider_id text null,
    external_transaction_id text null,
    idempotency_key text null,
    payload_hash char(64) null,
    wallet_id uuid not null,
    player_id text not null,
    round_id text null,
    game_id text null,
    kind text not null,
    amount numeric(20,2) not null,
    currency char(3) not null,
    reference_external_transaction_id text null,
    status text not null,
    reference_transaction_id uuid null,
    failure_code text null,
    processed_at timestamptz null,
    observed_balance numeric(20,2) null,
    reference_deadline timestamptz null,
    next_attempt_at timestamptz null,
    reference_attempts integer not null default 0,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    constraint wager_transactions_pkey primary key (id),
    constraint wager_transactions_idempotency_key_unique unique (idempotency_key),
    constraint wager_transactions_provider_external_id_unique unique (provider_id, external_transaction_id),
    constraint wager_transactions_wallet_fkey foreign key (wallet_id)
      references wallets (id) deferrable initially deferred,
    constraint wager_transactions_reference_fkey foreign key (reference_transaction_id)
      references wager_transactions (id) deferrable initially deferred,
    constraint wager_transactions_kind_check check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
    constraint wager_transactions_status_check check (status in ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
    constraint wager_transactions_failure_code_check check (failure_code in (
      'INSUFFICIENT_FUNDS', 'REVERSAL_WOULD_OVERDRAW', 'REFERENCE_NOT_FOUND', 'REFERENCE_MISMATCH',
      'REFERENCE_KIND_NOT_ALLOWED', 'REFERENCE_NOT_PROCESSED', 'REFERENCE_ALREADY_REVERSED',
      'AMOUNT_MISMATCH', 'CURRENCY_MISMATCH', 'WALLET_PLAYER_MISMATCH', 'INTERNAL_ERROR'
    )),
    constraint wager_transactions_currency_check check (currency ~ '^[A-Z]{3}$'),
    constraint wager_transactions_amount_check check (amount > 0 or (kind = 'LOSS' and amount = 0)),
    constraint wager_transactions_observed_balance_check check (observed_balance >= 0),
    constraint wager_transactions_reference_attempts_check check (reference_attempts >= 0),
    constraint wager_transactions_payload_hash_check check (payload_hash ~ '^[0-9a-f]{64}$'),
    constraint wager_transactions_provider_id_check check (char_length(provider_id) between 1 and 64),
    constraint wager_transactions_external_transaction_id_check check (char_length(external_transaction_id) between 1 and 128),
    constraint wager_transactions_idempotency_key_check check (char_length(idempotency_key) between 1 and 255),
    constraint wager_transactions_player_id_check check (char_length(player_id) between 1 and 128),
    constraint wager_transactions_round_id_check check (char_length(round_id) between 1 and 128),
    constraint wager_transactions_game_id_check check (char_length(game_id) between 1 and 128),
    constraint wager_transactions_reference_external_transaction_id_check check (char_length(reference_external_transaction_id) between 1 and 128),
    constraint wager_transactions_provider_fields_check check (
      case when kind = 'OPENING'
        then num_nonnulls(provider_id, external_transaction_id, idempotency_key, payload_hash, round_id, game_id) = 0
        else num_nulls(provider_id, external_transaction_id, idempotency_key, payload_hash, round_id, game_id) = 0
      end
    ),
    constraint wager_transactions_reference_kind_check check (
      case kind
        when 'REFUND' then reference_external_transaction_id is not null
        when 'ROLLBACK' then reference_external_transaction_id is not null
        when 'BET' then reference_external_transaction_id is null
        when 'OPENING' then reference_external_transaction_id is null
        else true
      end
    ),
    constraint wager_transactions_reference_resolution_check check (
      (reference_transaction_id is not null) = (status = 'PROCESSED' and reference_external_transaction_id is not null)
    ),
    constraint wager_transactions_failure_check check (
      (failure_code is not null) = (status in ('REJECTED', 'FAILED'))
      and (failure_code is not distinct from 'INTERNAL_ERROR') = (status = 'FAILED')
    ),
    constraint wager_transactions_processed_at_check check ((processed_at is not null) = (status = 'PROCESSED')),
    constraint wager_transactions_observed_balance_presence_check check (
      case
        when status in ('PROCESSED', 'PENDING_REFERENCE') then observed_balance is not null
        when failure_code in ('WALLET_PLAYER_MISMATCH', 'CURRENCY_MISMATCH') then observed_balance is null
        else true
      end
    ),
    constraint wager_transactions_reference_wait_check check (
      case
        when status = 'PENDING_REFERENCE' then reference_deadline is not null
          and next_attempt_at is not null and next_attempt_at <= reference_deadline
        else next_attempt_at is null
      end
      and (reference_deadline is null or reference_external_transaction_id is not null)
    )
  )`,
  `comment on table wager_transactions is 'Wagering transactions and their outcome. PENDING is never stored; PROCESSED, REJECTED and FAILED rows are frozen. Provider fields are null only for the internal OPENING credit.'`,
  `create unique index wager_transactions_opening_unique
    on wager_transactions (wallet_id) where kind = 'OPENING'`,
  `create unique index wager_transactions_reversal_unique
    on wager_transactions (reference_transaction_id)
    where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK')`,
  `comment on index wager_transactions_reversal_unique is 'At most one applied reversal per transaction: a REFUND and a ROLLBACK of the same transaction are mutually exclusive.'`,
  `create index wager_transactions_pending_reference_idx
    on wager_transactions (created_at, id) where status = 'PENDING_REFERENCE'`,

  `create table ledger_entries (
    id uuid not null,
    transaction_id uuid not null,
    wallet_id uuid not null,
    wallet_version integer not null,
    direction text not null,
    debit_account_id uuid not null,
    credit_account_id uuid not null,
    amount numeric(20,2) not null,
    currency char(3) not null,
    balance_before numeric(20,2) not null,
    balance_after numeric(20,2) not null,
    created_at timestamptz not null,
    constraint ledger_entries_pkey primary key (id),
    constraint ledger_entries_transaction_id_unique unique (transaction_id),
    constraint ledger_entries_wallet_version_unique unique (wallet_id, wallet_version),
    constraint ledger_entries_transaction_fkey foreign key (transaction_id)
      references wager_transactions (id) deferrable initially deferred,
    constraint ledger_entries_wallet_fkey foreign key (wallet_id, currency)
      references wallets (id, currency) deferrable initially deferred,
    constraint ledger_entries_amount_check check (amount > 0),
    constraint ledger_entries_balances_check check (balance_before >= 0 and balance_after >= 0),
    constraint ledger_entries_wallet_version_check check (wallet_version >= 1),
    constraint ledger_entries_currency_check check (currency ~ '^[A-Z]{3}$'),
    constraint ledger_entries_direction_check check (direction in ('DEBIT', 'CREDIT')),
    constraint ledger_entries_accounts_check check (debit_account_id <> credit_account_id),
    constraint ledger_entries_wallet_side_check check (
      case direction when 'DEBIT' then debit_account_id = wallet_id else credit_account_id = wallet_id end
    ),
    constraint ledger_entries_balance_after_check check (
      balance_after = case direction when 'DEBIT' then balance_before - amount else balance_before + amount end
    )
  )`,
  `comment on table ledger_entries is 'Append-only double-entry ledger: one row per balance change, moving a positive amount from the debited to the credited account, with the wallet side (direction, balances, version) of the movement.'`,

  `create table inbox_messages (
    consumer_name text not null,
    message_id text not null,
    payload_hash char(64) not null,
    received_at timestamptz not null,
    processed_at timestamptz null,
    constraint inbox_messages_pkey primary key (consumer_name, message_id),
    constraint inbox_messages_consumer_name_check check (char_length(consumer_name) between 1 and 80),
    constraint inbox_messages_message_id_check check (char_length(message_id) between 1 and 128),
    constraint inbox_messages_payload_hash_check check (payload_hash ~ '^[0-9a-f]{64}$')
  )`,
  `comment on table inbox_messages is 'Consumed queue messages, written in the same SQL transaction as their effects: a redelivery is recognized and has no effect.'`,

  `create table outbox_messages (
    id uuid not null,
    sequence_number bigint generated always as identity,
    aggregate_id uuid not null,
    ordering_key uuid not null,
    event_type text not null,
    payload jsonb not null,
    occurred_at timestamptz not null,
    attempts integer not null default 0,
    next_attempt_at timestamptz null,
    published_at timestamptz null,
    constraint outbox_messages_pkey primary key (id),
    constraint outbox_messages_sequence_number_unique unique (sequence_number),
    constraint outbox_messages_event_type_check check (char_length(event_type) between 1 and 100),
    constraint outbox_messages_payload_check check (jsonb_typeof(payload) = 'object'),
    constraint outbox_messages_attempts_check check (attempts >= 0),
    constraint outbox_messages_schedule_check check ((published_at is null) = (next_attempt_at is not null))
  )`,
  `comment on table outbox_messages is 'Integration events written with the change they describe and published after the commit. sequence_number is assigned at insert, under the wallet lock, and orders the events of a wallet (ordering_key). An unpublished event is never deleted; a published one is final and may be purged.'`,
  `create index outbox_messages_pending_idx
    on outbox_messages (ordering_key, sequence_number) where published_at is null`,
];

const GUARDS = [
  // Shared by the insert-only tables; the trigger passes the rule's name as its argument.
  `create function reject_row_change() returns trigger language plpgsql as $$
  begin
    raise exception '% is insert-only: % is not allowed', tg_table_name, tg_op
      using errcode = 'integrity_constraint_violation', constraint = tg_argv[0],
        table = tg_table_name;
  end;
  $$`,
  `create trigger ledger_entries_append_only
    before update or delete on ledger_entries
    for each row execute function reject_row_change('ledger_entries_append_only')`,
  `create trigger ledger_entries_no_truncate
    before truncate on ledger_entries
    for each statement execute function reject_row_change('ledger_entries_append_only')`,
  `create trigger ledger_accounts_immutable
    before update or delete on ledger_accounts
    for each row execute function reject_row_change('ledger_accounts_immutable')`,
  `create trigger ledger_accounts_no_truncate
    before truncate on ledger_accounts
    for each statement execute function reject_row_change('ledger_accounts_immutable')`,

  // An unpublished event is never lost: it cannot be deleted, and nothing but its publication
  // schedule changes until it is published. A published event is final and may be purged.
  `create function outbox_messages_guard() returns trigger language plpgsql as $$
  begin
    if tg_op = 'TRUNCATE' then
      raise exception 'outbox messages cannot be truncated: unpublished events would be lost'
        using errcode = 'integrity_constraint_violation', constraint = 'outbox_messages_never_lost',
          table = tg_table_name;
    end if;
    if tg_op = 'DELETE' then
      if old.published_at is null then
        raise exception 'event % has not been published and cannot be deleted', old.id
          using errcode = 'integrity_constraint_violation', constraint = 'outbox_messages_never_lost',
            table = tg_table_name;
      end if;
      return old;
    end if;
    if old.published_at is not null then
      raise exception 'event % was already published', old.id
        using errcode = 'integrity_constraint_violation', constraint = 'outbox_messages_published_final',
          table = tg_table_name;
    end if;
    -- sequence_number too: SET sequence_number = DEFAULT would draw a new value and move the
    -- event behind later events of its wallet.
    if (new.id, new.sequence_number, new.aggregate_id, new.ordering_key, new.event_type,
        new.payload, new.occurred_at)
       is distinct from
       (old.id, old.sequence_number, old.aggregate_id, old.ordering_key, old.event_type,
        old.payload, old.occurred_at) then
      raise exception 'event % never changes, only its publication schedule', old.id
        using errcode = 'integrity_constraint_violation', constraint = 'outbox_messages_event_immutable',
          table = tg_table_name;
    end if;
    if new.attempts < old.attempts then
      raise exception 'the attempts of event % never decrease', old.id
        using errcode = 'integrity_constraint_violation',
          constraint = 'outbox_messages_attempts_monotonic', table = tg_table_name;
    end if;
    return new;
  end;
  $$`,
  `create trigger outbox_messages_guard
    before update or delete on outbox_messages
    for each row execute function outbox_messages_guard()`,
  `create trigger outbox_messages_no_truncate
    before truncate on outbox_messages
    for each statement execute function outbox_messages_guard()`,

  `create function wallets_guard() returns trigger language plpgsql as $$
  begin
    if tg_op = 'DELETE' then
      raise exception 'wallet % cannot be deleted', old.id
        using errcode = 'integrity_constraint_violation', constraint = 'wallets_never_deleted',
          table = tg_table_name;
    end if;
    if (new.id, new.player_id, new.currency, new.created_at)
       is distinct from (old.id, old.player_id, old.currency, old.created_at) then
      raise exception 'the owner, currency and creation time of wallet % never change', old.id
        using errcode = 'integrity_constraint_violation', constraint = 'wallets_identity_immutable',
          table = tg_table_name;
    end if;
    return new;
  end;
  $$`,
  `create trigger wallets_guard
    before update or delete on wallets
    for each row execute function wallets_guard()`,

  `create function wager_transactions_guard() returns trigger language plpgsql as $$
  begin
    if tg_op = 'INSERT' then
      if new.status = 'FAILED' then
        raise exception 'transaction % cannot be stored as FAILED: only a parked transaction fails', new.id
          using errcode = 'integrity_constraint_violation',
            constraint = 'wager_transactions_failed_only_from_pending_reference', table = tg_table_name;
      end if;
      return new;
    end if;
    if tg_op = 'DELETE' then
      raise exception 'transaction % cannot be deleted', old.id
        using errcode = 'integrity_constraint_violation', constraint = 'wager_transactions_never_deleted',
          table = tg_table_name;
    end if;
    if old.status <> 'PENDING_REFERENCE' then
      raise exception 'transaction % is %, a terminal state', old.id, old.status
        using errcode = 'integrity_constraint_violation', constraint = 'wager_transactions_terminal_state',
          table = tg_table_name;
    end if;
    if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
        new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.amount, new.currency,
        new.reference_external_transaction_id, new.reference_deadline, new.created_at)
       is distinct from
       (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
        old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.amount, old.currency,
        old.reference_external_transaction_id, old.reference_deadline, old.created_at) then
      raise exception 'only the outcome of transaction % can change', old.id
        using errcode = 'integrity_constraint_violation', constraint = 'wager_transactions_immutable_fields',
          table = tg_table_name;
    end if;
    if new.reference_attempts < old.reference_attempts then
      raise exception 'the reference attempts of transaction % never decrease', old.id
        using errcode = 'integrity_constraint_violation',
          constraint = 'wager_transactions_reference_attempts_monotonic', table = tg_table_name;
    end if;
    return new;
  end;
  $$`,
  `create trigger wager_transactions_guard
    before insert or update or delete on wager_transactions
    for each row execute function wager_transactions_guard()`,
];

// Deferred to the commit, when every row of the unit of work is visible. A row may change more
// than once in a transaction, so the checks read its current state rather than the event's NEW.
const CONSISTENCY = [
  `create function ledger_entries_check_consistency() returns trigger language plpgsql as $$
  declare
    tx wager_transactions%rowtype;
    counter_account ledger_accounts%rowtype;
    expected_direction text;
    previous_balance numeric(20,2);
    next_balance numeric(20,2);
    current_wallet wallets%rowtype;
  begin
    -- The entry records an applied transaction that moves the balance, with its wallet, amount
    -- and currency, in the direction its kind implies (a ROLLBACK mirrors its reference), and
    -- against the right counter-account, in the same currency: FUNDING for the OPENING credit,
    -- which is always the wallet's first version, and the provider's settlement account for
    -- everything else. The transaction's stored snapshot is the balance this entry ends at, so
    -- a replay answers what the first call did. The counter-account is read, never locked:
    -- accounts are insert-only, and no foreign key points at them from the ledger.
    select * into tx from wager_transactions where id = new.transaction_id;
    if tx.id is null or tx.status <> 'PROCESSED' or tx.kind = 'LOSS' then
      raise exception 'ledger entry % must record an applied transaction that moves the balance', new.id
        using errcode = 'check_violation', constraint = 'ledger_entries_transaction_match',
          table = tg_table_name;
    end if;
    expected_direction := case tx.kind
      when 'BET' then 'DEBIT'
      when 'ROLLBACK' then (
        select case direction when 'DEBIT' then 'CREDIT' else 'DEBIT' end
        from ledger_entries where transaction_id = tx.reference_transaction_id)
      else 'CREDIT'
    end;
    select * into counter_account from ledger_accounts
      where id = case new.direction when 'DEBIT' then new.credit_account_id else new.debit_account_id end;
    if (tx.wallet_id, tx.amount, tx.currency) is distinct from (new.wallet_id, new.amount, new.currency)
       or tx.observed_balance is distinct from new.balance_after
       or new.direction is distinct from expected_direction
       or (tx.kind = 'OPENING') <> (new.wallet_version = 1)
       or counter_account.id is null
       or counter_account.currency is distinct from new.currency
       -- In an IF condition, a CASE must be parenthesized: PL/pgSQL ends the condition at the
       -- first THEN it sees outside parentheses.
       or counter_account.type is distinct from
          (case tx.kind when 'OPENING' then 'FUNDING' else 'PROVIDER_SETTLEMENT' end)
       or (tx.kind <> 'OPENING' and counter_account.provider_id is distinct from tx.provider_id) then
      raise exception 'ledger entry % does not match transaction %', new.id, tx.id
        using errcode = 'check_violation', constraint = 'ledger_entries_transaction_match',
          table = tg_table_name;
    end if;

    -- The entries of a wallet form an unbroken chain from a zero balance: version 1 is the
    -- OPENING credit, and a wallet opened at zero starts at version 2.
    if new.wallet_version = 1 then
      if new.balance_before <> 0 then
        raise exception 'ledger entry % opens wallet % from a non-zero balance', new.id, new.wallet_id
          using errcode = 'check_violation', constraint = 'ledger_entries_chain', table = tg_table_name;
      end if;
    else
      select balance_after into previous_balance from ledger_entries
        where wallet_id = new.wallet_id and wallet_version = new.wallet_version - 1;
      if found then
        if previous_balance <> new.balance_before then
          raise exception 'ledger entry % does not continue from version % of wallet %',
            new.id, new.wallet_version - 1, new.wallet_id
            using errcode = 'check_violation', constraint = 'ledger_entries_chain', table = tg_table_name;
        end if;
      elsif new.wallet_version <> 2 or new.balance_before <> 0 then
        raise exception 'ledger entry % leaves a gap before version % of wallet %',
          new.id, new.wallet_version, new.wallet_id
          using errcode = 'check_violation', constraint = 'ledger_entries_chain', table = tg_table_name;
      end if;
    end if;
    select balance_before into next_balance from ledger_entries
      where wallet_id = new.wallet_id and wallet_version = new.wallet_version + 1;
    if found and next_balance <> new.balance_after then
      raise exception 'ledger entry % does not lead to version % of wallet %',
        new.id, new.wallet_version + 1, new.wallet_id
        using errcode = 'check_violation', constraint = 'ledger_entries_chain', table = tg_table_name;
    end if;

    -- The wallet has reached the version this entry produced and, if this entry is its last,
    -- holds the balance it ends at. This also covers an entry written without touching the
    -- wallet row, which the wallet's own check would never see.
    select * into current_wallet from wallets where id = new.wallet_id;
    if current_wallet.id is null
       or current_wallet.version < new.wallet_version
       or (current_wallet.version = new.wallet_version and current_wallet.balance <> new.balance_after) then
      raise exception 'ledger entry % does not agree with the head of wallet %', new.id, new.wallet_id
        using errcode = 'check_violation', constraint = 'ledger_entries_wallet_head',
          table = tg_table_name;
    end if;
    return null;
  end;
  $$`,
  `create constraint trigger ledger_entries_consistency
    after insert on ledger_entries
    deferrable initially deferred
    for each row execute function ledger_entries_check_consistency()`,

  `create function wallets_check_consistency() returns trigger language plpgsql as $$
  declare
    current_wallet wallets%rowtype;
    head_balance numeric(20,2);
  begin
    select * into current_wallet from wallets where id = new.id;
    if current_wallet.id is null then
      return null;
    end if;
    -- The wallet holds the balance its ledger ends at, at the version of its last entry. A
    -- wallet opened at zero has no entry and stays at version 1 until its first movement.
    select balance_after into head_balance from ledger_entries
      where wallet_id = current_wallet.id and wallet_version = current_wallet.version;
    if found then
      if head_balance <> current_wallet.balance then
        raise exception 'wallet % does not hold the balance its ledger ends at, version %',
          current_wallet.id, current_wallet.version
          using errcode = 'check_violation', constraint = 'wallets_ledger_head', table = tg_table_name,
            detail = format('balance %s, ledger %s', current_wallet.balance, head_balance);
      end if;
    elsif current_wallet.version <> 1 or current_wallet.balance <> 0 then
      raise exception 'wallet % is at version %, but no ledger entry produced it',
        current_wallet.id, current_wallet.version
        using errcode = 'check_violation', constraint = 'wallets_ledger_head', table = tg_table_name,
          detail = format('balance %s', current_wallet.balance);
    end if;
    if exists (select 1 from ledger_entries
               where wallet_id = current_wallet.id and wallet_version > current_wallet.version) then
      raise exception 'wallet % is behind its ledger', current_wallet.id
        using errcode = 'check_violation', constraint = 'wallets_ledger_head', table = tg_table_name;
    end if;
    -- Every wallet has its own ledger account, in its currency.
    if not exists (select 1 from ledger_accounts
                   where id = current_wallet.id and type = 'PLAYER_WALLET'
                     and currency = current_wallet.currency) then
      raise exception 'wallet % has no ledger account', current_wallet.id
        using errcode = 'check_violation', constraint = 'wallets_ledger_account', table = tg_table_name;
    end if;
    return null;
  end;
  $$`,
  `create constraint trigger wallets_consistency
    after insert or update on wallets
    deferrable initially deferred
    for each row execute function wallets_check_consistency()`,

  `create function wager_transactions_check_consistency() returns trigger language plpgsql as $$
  declare
    current_tx wager_transactions%rowtype;
    referenced wager_transactions%rowtype;
    target_wallet wallets%rowtype;
  begin
    select * into current_tx from wager_transactions where id = new.id;
    if current_tx.status is distinct from 'PROCESSED' then
      return null;
    end if;
    -- Only a transaction of the wallet's own player and currency is applied to it; a mismatch
    -- is rejected, never applied. A LOSS has no ledger entry, so this is its only check.
    select * into target_wallet from wallets where id = current_tx.wallet_id;
    if (target_wallet.player_id, target_wallet.currency) is distinct from (current_tx.player_id, current_tx.currency) then
      raise exception 'transaction % was applied to a wallet of another player or currency', current_tx.id
        using errcode = 'check_violation', constraint = 'wager_transactions_wallet_match',
          table = tg_table_name;
    end if;
    -- Every applied transaction that moves the balance has its ledger entry.
    if current_tx.kind <> 'LOSS'
       and not exists (select 1 from ledger_entries where transaction_id = current_tx.id) then
      raise exception 'transaction % was applied without its ledger entry', current_tx.id
        using errcode = 'check_violation', constraint = 'wager_transactions_ledger_entry',
          table = tg_table_name;
    end if;
    if current_tx.reference_transaction_id is null then
      return null;
    end if;
    -- The reference is the provider's transaction it names: applied, in the same wallet, round
    -- and currency, of a kind this operation may reference, and with the same amount when this
    -- operation reverses it.
    select * into referenced from wager_transactions where id = current_tx.reference_transaction_id;
    if referenced.id is null
       or referenced.status <> 'PROCESSED'
       or (referenced.provider_id, referenced.external_transaction_id, referenced.wallet_id,
           referenced.player_id, referenced.round_id, referenced.currency)
          is distinct from
          (current_tx.provider_id, current_tx.reference_external_transaction_id, current_tx.wallet_id,
           current_tx.player_id, current_tx.round_id, current_tx.currency)
       or not (case current_tx.kind
                 when 'ROLLBACK' then referenced.kind in ('BET', 'WIN', 'REFUND')
                 else referenced.kind = 'BET'
               end)
       or (current_tx.kind in ('REFUND', 'ROLLBACK') and referenced.amount <> current_tx.amount) then
      raise exception 'transaction % does not match its reference %', current_tx.id, referenced.id
        using errcode = 'check_violation', constraint = 'wager_transactions_reference_match',
          table = tg_table_name;
    end if;
    -- No WIN or LOSS settles a bet that was reversed.
    if current_tx.kind in ('WIN', 'LOSS') and exists (
         select 1 from wager_transactions
         where reference_transaction_id = referenced.id and status = 'PROCESSED'
           and kind in ('REFUND', 'ROLLBACK')) then
      raise exception 'transaction % settles bet %, which was reversed', current_tx.id, referenced.id
        using errcode = 'check_violation', constraint = 'wager_transactions_reference_reversed',
          table = tg_table_name;
    end if;
    return null;
  end;
  $$`,
  `create constraint trigger wager_transactions_consistency
    after insert or update on wager_transactions
    deferrable initially deferred
    for each row when (new.status = 'PROCESSED')
    execute function wager_transactions_check_consistency()`,
];

const DOWN = [
  "drop table outbox_messages",
  "drop table inbox_messages",
  "drop table ledger_entries",
  "drop table wager_transactions",
  "drop table ledger_accounts",
  "drop table wallets",
  "drop function wager_transactions_check_consistency()",
  "drop function wallets_check_consistency()",
  "drop function ledger_entries_check_consistency()",
  "drop function wager_transactions_guard()",
  "drop function wallets_guard()",
  "drop function outbox_messages_guard()",
  "drop function reject_row_change()",
];

export class Migration20261122053903_initial_schema extends Migration {
  override name = "Migration20261122053903_initial_schema";

  override up(): void {
    for (const statement of [...TABLES, ...GUARDS, ...CONSISTENCY]) {
      this.addSql(statement);
    }
  }

  override down(): void {
    for (const statement of DOWN) {
      this.addSql(statement);
    }
  }
}
