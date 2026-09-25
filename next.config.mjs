/** @type {import('next').NextConfig} */
// NEXT_DIST_DIR permite compilar las pruebas e2e en otra carpeta (.next-e2e) sin pisar el servidor de :3000.
export default { reactStrictMode: true, distDir: process.env.NEXT_DIST_DIR || ".next" };
