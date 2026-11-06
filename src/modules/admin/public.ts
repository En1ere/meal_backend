export {
    adminDetailSchema,
    adminPageSchema,
    adminRecordSchema,
    adminRelatedPageSchema,
    adminRelatedSearchSchema,
    adminSearchSchema,
    adminSectionSchema,
    type AdminRecord,
    type AdminRelatedSearch,
    type AdminSearch,
    type AdminSection,
} from './admin-read.contracts.js';
export { AdminReadController } from './admin-read.http.js';
export { AdminReadService, cursorBinding, decodeAdminCursor, projectAdminRecord } from './admin-read.service.js';
export { adminSources } from './admin-read.sources.js';
export { adminRelatedSources, relatedCollections, type RelatedSource } from './admin-related.sources.js';
