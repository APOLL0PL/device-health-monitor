module.exports = {
  apps: [
    {
      name: 'dhm-server',
      script: 'index.js',
      env: {
        PORT: process.env.PORT || '4000',
        AUTH_TOKEN: process.env.AUTH_TOKEN || '',
        REGISTER_TOKEN: process.env.REGISTER_TOKEN || '',
      },
    },
  ],
};
