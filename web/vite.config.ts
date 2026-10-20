import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
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
          target: 'http://localhost:8024',
          changeOrigin: true
        },
        '/library': {
          target: 'http://localhost:8024',
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
