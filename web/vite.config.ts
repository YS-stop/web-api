import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  // 后端地址：每台电脑用 .env.local 配置（不进 git），默认本机 8024。
  // 例：另一台电脑访问 A 后端时写 VITE_BACKEND_URL=http://192.168.20.239:8024
  const backend = env.VITE_BACKEND_URL || 'http://localhost:8024';
  return {
    server: {
      host: '0.0.0.0',
      port: 8025,
      watch: {
        // 忽略后端目录/临时目录/二进制文件，避免编辑时被锁定(EBUSY)导致 Vite 崩溃
        ignored: [
          '**/*.docx', '**/*.doc', '**/*.xlsx', '**/*.xls', '**/*.pptx', '**/*.ppt', '**/*.pdf',
          'server/**',
          'library/**',
          'models/**',
          'venv/**',
          '**/*.tmpdir/**'
        ]
      },
      proxy: {
        '/api': {
          target: backend,
          changeOrigin: true
        },
        '/library': {
          target: backend,
          changeOrigin: true
        }
      }
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    }
  };
});
