import type { ThemeRegistrationRaw } from "shiki";

// Xcode palettes adapted from MacOS Modern (MIT):
// https://github.com/davidbwaters/macos-modern-vscode-theme
export const xcodeLightTheme = {
	name: "xcode-default-light",
	type: "light",
	colors: {
		"editor.background": "#FFFFFF",
		"editor.foreground": "#000000",
	},
	settings: [
		{
			name: "Comments",
			scope: "comment",
			settings: { foreground: "#008E00" },
		},
		{
			name: "Preprocessor statements",
			scope: ["meta.preprocessor", "keyword.control.import"],
			settings: { foreground: "#7D4726" },
		},
		{
			name: "Strings",
			scope: "string",
			settings: { foreground: "#DF0002" },
		},
		{
			name: "Numbers",
			scope: "constant.numeric",
			settings: { foreground: "#3A00DC" },
		},
		{
			name: "Language constants and keywords",
			scope: [
				"constant.language",
				"keyword",
				"storage",
				"variable.language",
				"variable.other",
			],
			settings: { foreground: "#C800A4" },
		},
		{
			name: "User-defined constants",
			scope: ["constant.character", "constant.other"],
			settings: { foreground: "#275A5E" },
		},
		{
			name: "Class names",
			scope: "entity.name.class",
			settings: { foreground: "#438288" },
		},
		{
			name: "Tags",
			scope: "entity.name.tag",
			settings: { foreground: "#790EAD" },
		},
		{
			name: "Attributes and library functions",
			scope: [
				"entity.other.attribute-name",
				"support.function",
				"support.constant",
			],
			settings: { foreground: "#450084" },
		},
		{
			name: "Library types and variables",
			scope: ["support.type", "support.class", "support.other.variable"],
			settings: { foreground: "#790EAD" },
		},
	],
} satisfies ThemeRegistrationRaw;

export const xcodeDarkTheme = {
	name: "xcode-default-dark",
	type: "dark",
	colors: {
		"editor.background": "#242529",
		"editor.foreground": "#FFFFFF",
	},
	settings: [
		{
			name: "Comments",
			scope: "comment",
			settings: { foreground: "#6C7986" },
		},
		{
			name: "Strings",
			scope: "string",
			settings: { foreground: "#FC6A5D" },
		},
		{
			name: "Numbers and constants",
			scope: [
				"constant.numeric",
				"constant.language",
				"constant.character",
				"constant.other",
			],
			settings: { foreground: "#9686F5" },
		},
		{
			name: "Variables",
			scope: "variable",
			settings: { foreground: "#53A5FB" },
		},
		{
			name: "Keywords",
			scope: ["keyword", "storage"],
			settings: { foreground: "#FC5FA3" },
		},
		{
			name: "Types, classes, and functions",
			scope: [
				"storage.type",
				"entity.name.class",
				"entity.other.inherited-class",
				"entity.name.function",
			],
			settings: { foreground: "#91D462" },
		},
		{
			name: "Function arguments",
			scope: "variable.parameter",
			settings: { foreground: "#FD8F3F" },
		},
		{
			name: "Tags",
			scope: "entity.name.tag",
			settings: { foreground: "#FC5FA3" },
		},
		{
			name: "Attributes",
			scope: "entity.other.attribute-name",
			settings: { foreground: "#75B492" },
		},
		{
			name: "Library functions, constants, and types",
			scope: [
				"support.function",
				"support.constant",
				"support.type",
				"support.class",
			],
			settings: { foreground: "#7AC8B6" },
		},
	],
} satisfies ThemeRegistrationRaw;
