import { Global, Module, type DynamicModule } from '@nestjs/common';
import { DatabaseService } from '../infrastructure/database/database.service.js';
import { AdminAccessService, AdminSessionGuard } from '../modules/admin-auth/public.js';
import { AuthCookies, UserSessionGuard } from '../modules/auth/auth.http.js';
import { STAFF_SESSION_GUARD, StaffSessionGuard } from '../modules/auth/public.js';
import { AuthService } from '../modules/auth/auth.service.js';
import { APP_CONFIG, type AppConfig } from './config.js';

@Global()
@Module({})
export class CoreRuntimeModule {
    static configure(config: AppConfig): DynamicModule {
        return {
            module: CoreRuntimeModule,
            providers: [
                { provide: APP_CONFIG, useValue: config },
                DatabaseService,
                AuthService,
                AdminAccessService,
                AuthCookies,
                UserSessionGuard,
                StaffSessionGuard,
                { provide: STAFF_SESSION_GUARD, useExisting: StaffSessionGuard },
                AdminSessionGuard,
            ],
            exports: [
                APP_CONFIG,
                DatabaseService,
                AuthService,
                AdminAccessService,
                AuthCookies,
                UserSessionGuard,
                StaffSessionGuard,
                STAFF_SESSION_GUARD,
                AdminSessionGuard,
            ],
        };
    }
}
