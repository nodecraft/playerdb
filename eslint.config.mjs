import nodecraft from '@nodecraft/eslint-config';

const jsonIgnore = ['**/*.json'];
const withJsonIgnore = function(configs) {
	return configs.map(function(config) {
		return {
			...config,
			ignores: [...(config.ignores || []), ...jsonIgnore],
		};
	});
};

export default [
	// Global ignores
	{
		ignores: [
			'.localflare/**',
			'.wrangler/**',
		],
	},

	// Node + TypeScript config (typescript includes base)
	...withJsonIgnore(nodecraft.configs.node),
	...withJsonIgnore(nodecraft.configs.typescript),

	// JSON
	...nodecraft.configs.json,

	// Overrides
	{
		ignores: jsonIgnore,
		rules: {
			'n/no-unsupported-features/node-builtins': 'off',
		},
	},
];
