export interface AppConfig {
    NODE_ENV: 'development' | 'test' | 'production';
    HOST: string;
    PORT: number;
    FRONTEND_ORIGIN: string;
    ADMIN_FRONTEND_ORIGIN?: string | undefined;
    ADMIN_ALLOWED_IPS: string[];
    DATABASE_URL?: string | undefined;
    DATABASE_POOL_SIZE: number;
    OBSERVABILITY_HOST_SNAPSHOT_ENABLED: boolean;
    OBSERVABILITY_HOST_SNAPSHOT_FILE?: string | undefined;
    WORKER_OWNER_ID?: string | undefined;
    COOKING_LIFECYCLE_ENABLED: boolean;
    LOG_LEVEL: 'silent' | 'error' | 'warn' | 'info' | 'debug';
    APP_VERSION?: string | undefined;
    SECURITY_KEY?: string | undefined;
    MFA_ENCRYPTION_KEY?: string | undefined;
    ACCOUNT_MAIL_ENABLED: boolean;
    ACCOUNT_MAIL_TOKEN_KEY?: string | undefined;
    AUTH_RATE_LIMIT: number;
    PIN_TRUST_DAYS: number;
    REGISTRATION_RISK_ENABLED: boolean;
    REGISTRATION_RISK_FAILURE_MODE: 'fail_closed' | 'fail_open';
    REGISTRATION_DISPOSABLE_EMAIL_CHECK: boolean;
    REGISTRATION_CAPTCHA_MODE: 'disabled' | 'risk_based' | 'always';
    REGISTRATION_DENY_RISK_SCORE: number;
    AI_API_BASE_URL?: string | undefined;
    AI_API_TOKEN?: string | undefined;
    AI_MODEL?: string | undefined;
    AI_RECONCILIATION_ENABLED: boolean;
    TRUSTED_PROXY_CIDRS: string[];
}

export const APP_CONFIG = Symbol('APP_CONFIG');
