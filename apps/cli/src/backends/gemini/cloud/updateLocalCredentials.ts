import chalk from 'chalk';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { resolveGeminiConfigPaths } from '../utils/resolveGeminiConfigPaths';
import { warn } from '@happier-dev/cli-common/output';

type GeminiOAuthTokens = Readonly<{
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function updateLocalGeminiCredentials(oauth: unknown): void {
  if (!isRecord(oauth) || typeof oauth.access_token !== 'string') {
    return;
  }

  const tokens = oauth as GeminiOAuthTokens;

  try {
    const { userOauthCredsPath: credentialsPath } = resolveGeminiConfigPaths(process.env);
    const geminiDir = dirname(credentialsPath);

    if (!existsSync(geminiDir)) {
      mkdirSync(geminiDir, { recursive: true });
    }

    const credentials = {
      access_token: tokens.access_token,
      token_type: tokens.token_type || 'Bearer',
      scope: tokens.scope || 'https://www.googleapis.com/auth/cloud-platform',
      ...(tokens.refresh_token && { refresh_token: tokens.refresh_token }),
      ...(tokens.id_token && { id_token: tokens.id_token }),
      ...(tokens.expires_in && { expires_in: tokens.expires_in }),
    };

    writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2), 'utf-8');
    console.log(chalk.gray(`  Updated local credentials: ${credentialsPath}`));
  } catch (error) {
    console.log(`  ${warn(`Could not update local credentials: ${error}`)}`);
  }
}
