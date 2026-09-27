import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The custom server owns Socket.io; these must stay require()-able at runtime.
  serverExternalPackages: [
    '@prisma/client',
    'prisma',
    'bcryptjs',
    'exceljs',
    'qrcode',
    'socket.io',
  ],
};


export default nextConfig;
