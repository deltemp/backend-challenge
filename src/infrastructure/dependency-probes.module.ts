import { Global, Module } from "@nestjs/common";
import { DependencyProbes } from "./dependency-probes";

@Global()
@Module({ providers: [DependencyProbes], exports: [DependencyProbes] })
export class DependencyProbesModule {}
