import { Module } from '@nestjs/common';
import { SearchController, SearchService } from '../../modules/search/public.js';

@Module({
    imports: [],
    controllers: [SearchController],
    providers: [SearchService],
    exports: [],
})
export class SearchCapabilityModule {}
