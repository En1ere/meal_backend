import { ForbiddenException, Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { BlockList, isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import { APP_CONFIG, type AppConfig } from '../../app/config.js';

@Injectable()
export class AdminNetworkGuard implements CanActivate {
    private readonly allowed = new BlockList();

    constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
        for (const address of config.ADMIN_ALLOWED_IPS)
            this.allowed.addAddress(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');
    }

    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest<FastifyRequest>();
        const route = request.routeOptions.url;
        if (
            !(route === '/api/v1/admin' || route?.startsWith('/api/v1/admin/')) ||
            this.config.ADMIN_ALLOWED_IPS.length === 0
        )
            return true;
        const version = isIP(request.ip);
        if (!version || !this.allowed.check(request.ip, version === 4 ? 'ipv4' : 'ipv6'))
            throw new ForbiddenException();
        return true;
    }
}
