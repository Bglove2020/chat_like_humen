module.exports = {
  apps: [
    {
      name: 'chat-backend',
      cwd: '/home/zxr/chat_like_human/backend',
      script: 'dist/main.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'chat-worker',
      cwd: '/home/zxr/chat_like_human/worker',
      script: 'dist/main.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
