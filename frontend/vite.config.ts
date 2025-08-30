import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
	plugins: [
		tailwindcss(), 
		sveltekit(),
		VitePWA({
			registerType: 'autoUpdate',
			injectRegister: 'auto',
			includeAssets: ['favicon.ico', 'favicon-16.png', 'favicon-32.png', 'icon-192.png', 'icon-512.png', 'placeholder.jpg', 'logo.png'],
			manifest: {
				name: 'BubbleFish',
				short_name: 'BubbleFish',
				description: 'A powerful translation and annotation tool',
				theme_color: '#3b82f6',
				background_color: '#ffffff',
				display: 'standalone',
				orientation: 'any',
				scope: '/',
				start_url: '/',
				icons: [
					{
						src: '/favicon-16.png',
						sizes: '16x16',
						type: 'image/png'
					},
					{
						src: '/favicon-32.png',
						sizes: '32x32',
						type: 'image/png'
					},
					{
						src: '/icon-192.png',
						sizes: '192x192',
						type: 'image/png',
						purpose: 'any maskable'
					},
					{
						src: '/icon-512.png',
						sizes: '512x512',
						type: 'image/png',
						purpose: 'any maskable'
					}
				],
				categories: ['productivity', 'utilities'],
				lang: 'zh-CN'
			},
			workbox: {
				globPatterns: ['**/*.{js,css,html,png,jpg,jpeg,svg,gif,webp,woff,woff2,ttf,eot,ico}'],
				maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5MB to accommodate WASM files
				skipWaiting: true,
				clientsClaim: true,
				cleanupOutdatedCaches: true,
				runtimeCaching: [
					// 缓存图片资源
					{
						urlPattern: /\.(png|jpg|jpeg|svg|gif|webp|ico)$/i,
						handler: 'CacheFirst',
						options: {
							cacheName: 'images-cache',
							expiration: {
								maxEntries: 50,
								maxAgeSeconds: 60 * 60 * 24 * 365 // 1年
							},
							cacheableResponse: {
								statuses: [0, 200]
							}
						}
					},
					// 缓存 WASM 文件 - 使用运行时缓存而不是预缓存
					{
						urlPattern: /\.wasm$/i,
						handler: 'CacheFirst',
						options: {
							cacheName: 'wasm-cache',
							expiration: {
								maxEntries: 10,
								maxAgeSeconds: 60 * 60 * 24 * 365 // 1年
							},
							cacheableResponse: {
								statuses: [0, 200]
							},
							rangeRequests: true // 支持大文件的分片请求
						}
					},
					// 缓存 JS 和 CSS 资源
					{
						urlPattern: /\.(js|css)$/i,
						handler: 'CacheFirst',
						options: {
							cacheName: 'static-resources',
							expiration: {
								maxEntries: 60,
								maxAgeSeconds: 60 * 60 * 24 * 365 // 1年
							},
							cacheableResponse: {
								statuses: [0, 200]
							}
						}
					}
				]
			},
			devOptions: {
				enabled: false
			},
			// Ensure service worker is generated for production
			strategies: 'generateSW'
		}),
		// 自定义插件来处理 WASM 相关的 CORS 头部
		{
			name: 'wasm-cors-headers',
			configureServer(server) {
				server.middlewares.use((req, res, next) => {
					// 为所有资源设置 CORS 头部
					res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
					res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
					res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
					
					// 为 WASM 文件设置正确的 MIME 类型
					if (req.url?.endsWith('.wasm')) {
						res.setHeader('Content-Type', 'application/wasm');
					}
					
					next();
				});
			}
		}
	],
	server: {
		port: 5173,
		strictPort: true,
		host: 'localhost',
		fs: {
			allow: ['.', '../node_modules']
		},
		headers: {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
			'Cross-Origin-Resource-Policy': 'cross-origin'
		}
	},
	clearScreen: false,
	envPrefix: ['VITE_', 'TAURI_'],
	build: {
		target: process.env.TAURI_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
		minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
		sourcemap: !!process.env.TAURI_DEBUG,
		// rollupOptions 会被 SvelteKit 覆盖，所以移除以避免警告
	},
	optimizeDeps: {
		exclude: ['@tauri-apps/api', '@tauri-apps/plugin-os']
	},
	// 添加 WASM 支持
	assetsInclude: ['**/*.wasm'],
	worker: {
		format: 'es',
		plugins: () => [tailwindcss(), sveltekit()]
	},
	// 添加 WASM 相关配置
	define: {
		global: 'globalThis',
	}
});
