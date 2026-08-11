module.exports = {
  apps: [
    {
      name: 'dhm-agent',
      script: 'index.js',
      env: {
        SERVER_URL: process.env.SERVER_URL || 'http://localhost:4000',
        DEVICE_TYPE: process.env.DEVICE_TYPE || 'server',
        ...(process.env.DEVICE_NAME ? { DEVICE_NAME: process.env.DEVICE_NAME } : {}),
        ...(process.env.REPORT_INTERVAL ? { REPORT_INTERVAL: process.env.REPORT_INTERVAL } : {}),
        ...(process.env.REGISTER_TOKEN ? { REGISTER_TOKEN: process.env.REGISTER_TOKEN } : {}),
      },
    },
  ],
};
