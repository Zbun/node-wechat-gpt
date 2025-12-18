/** @type {import('next').NextConfig} */
const nextConfig = {};

// 仅在本地开发环境下设置 Cloudflare 平台
if (process.env.NODE_ENV === 'development') {
  const { setupDevPlatform } = await import('@cloudflare/next-on-pages/next-dev');
  await setupDevPlatform();
}

export default nextConfig;

