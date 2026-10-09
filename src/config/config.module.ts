import { type DynamicModule, Global, Module } from '@nestjs/common';
import { type Env, loadEnv } from './env';

export const APP_CONFIG = Symbol('APP_CONFIG');

@Global()
@Module({})
export class ConfigModule {
  static forRoot(env: Env = loadEnv()): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: Object.freeze({ ...env }) }],
      exports: [APP_CONFIG],
    };
  }
}
