import type { NextConfig } from 'next';
const config: NextConfig = { transpilePackages: ['@los/ui','@los/contracts','@los/calc'], output: 'standalone' };
export default config;
