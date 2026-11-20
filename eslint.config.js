import firebaseRulesPlugin from '@firebase/eslint-plugin-security-rules';

export default [
  {
    ignores: ['dist/**/*', 'node_modules/**/*', 'uploads/**/*', 'work/**/*', 'outputs/**/*'],
  },
  firebaseRulesPlugin.configs['flat/recommended'],
];
