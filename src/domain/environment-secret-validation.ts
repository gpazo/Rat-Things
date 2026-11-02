import { invalid } from './agents-api-validation.js';

export function validatePlainEnvironment(env: Readonly<Record<string, string>>, param: string): void {
  for (const [name, value] of Object.entries(env)) {
    const credentialName = /(?:^|_)(?:TOKEN|KEY)$|SECRET|PASSWORD|CREDENTIAL/i.test(name);
    const nonsecretName = /^(?:PUBLIC_KEY|SSH_PUBLIC_KEY|GPG_KEY|TERMINFO_KEY|SORT_KEY|PARTITION_KEY)$/i.test(name);
    const placeholder = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value) || /^rat_secret_[a-f0-9]{64}$/.test(value);
    if (credentialName && !nonsecretName && value && !placeholder) invalid(`Store ${name} in a Vault environment_variable credential and attach its vault_ids; use env_vars to inherit it in stdio MCP. Plain environment values must not contain credentials.`, param);
  }
}
