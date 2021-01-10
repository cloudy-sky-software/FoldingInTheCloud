module.exports = {
    "env": {
        "node": true,
        "es2021": true,
        "browser": false,
    },
    "extends": [
        "eslint:recommended",
        "plugin:@typescript-eslint/recommended",
        "plugin:import/errors",
        "plugin:import/warnings",
        "plugin:import/typescript",
    ],
    "parser": "@typescript-eslint/parser",
    "parserOptions": {
        "sourceType": "./tsconfig.json",
    },
    "plugins": [
        "@typescript-eslint",
    ],
    "rules": {
        "import/order": [
            "error",
            {
                "newlines-between": "always-and-inside-groups",
            },
        ],
        "indent": [
            "error",
            4,
        ],
        "linebreak-style": [
            "error",
            "unix",
        ],
        "max-len": [
            "error",
            {
                "code": 100,
                "ignoreUrls": true,
                "ignoreTemplateLiterals": true,
            },
        ],
        "quotes": [
            "error",
            "double",
        ],
        "semi": [
            "error",
            "always",
        ],
        "@typescript-eslint/no-explicit-any": "off",
        "@typescript-eslint/no-unused-vars": [
            "error",
            {
                "argsIgnorePattern": "^_",
                "caughtErrorsIgnorePattern": "^ignore",
                "varsIgnorePattern": "^_",
            },
        ],
        "comma-dangle": "off",
        "@typescript-eslint/comma-dangle": ["error", "always-multiline"],
    },
};
