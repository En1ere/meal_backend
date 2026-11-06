import { Module } from '@nestjs/common';
import { InventoryIngestController, InventoryIngestService } from '../../modules/inventory-ingest/public.js';

@Module({
    imports: [],
    controllers: [InventoryIngestController],
    providers: [InventoryIngestService],
    exports: [],
})
export class InventoryIngestCapabilityModule {}
