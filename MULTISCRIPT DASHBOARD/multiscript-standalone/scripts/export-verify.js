const { createExportService } = require('../server/services/export.service');
const { getLoggingConfig } = require('../server/config/logging.config');

const service = createExportService({
  runner: { getStatus: () => ({ runnerState: 'IDLE' }) },
  getLoggingConfig: () => getLoggingConfig('LIVE')
});

console.log(service.getExportPath('15'));
