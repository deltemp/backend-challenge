import { type CanActivate, Injectable, SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_ROUTE = "auth:isPublic";

/**
 * Marks a route that must stay open once authentication exists. Health endpoints must never
 * require authentication (§2 and §9 of the challenge statement).
 */
export const Public = () => SetMetadata(IS_PUBLIC_ROUTE, true);

/**
 * Authentication extension point.
 *
 * Authentication is deliberately not implemented in this challenge, so this guard admits every
 * request. The intended design uses an external identity provider (OIDC client credentials, one
 * client per game provider): this guard would validate the bearer token against the provider's
 * JWKS, skip routes marked {@link Public}, and bind the token's client to the `providerId` of
 * the request through a `ProviderIdentityPort`. See ARCHITECTURE.md.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
