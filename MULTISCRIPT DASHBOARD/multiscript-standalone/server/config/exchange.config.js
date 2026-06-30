const { env } = require('./env');

module.exports = {
  dhan: {
    name: 'Dhan',
    wsUrl: env.dhanWsUrl,
    restUrl: env.dhanRestUrl,
    clientId: env.dhanClientId,
    accessToken: env.dhanAccessToken,
    authType: env.dhanAuthType,
    version: env.dhanWsVersion,
    requestCode: env.dhanRequestCode
  }
};
