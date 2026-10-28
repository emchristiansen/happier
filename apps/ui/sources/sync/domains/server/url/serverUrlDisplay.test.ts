import { describe, expect, it } from 'vitest';

import { derivePresentableRelayHost, toRelayHostDisplay } from './serverUrlDisplay';

describe('relay host display', () => {
    it('names a relay by host, hiding the scheme and its default port', () => {
        expect(derivePresentableRelayHost('https://api.happier.dev')).toBe('api.happier.dev');
        expect(derivePresentableRelayHost('https://api.happier.dev:443/')).toBe('api.happier.dev');
        expect(derivePresentableRelayHost('http://localhost:80')).toBe('localhost');
    });

    it('keeps a port that is not the scheme default, because it identifies the relay', () => {
        expect(derivePresentableRelayHost('http://localhost:3005')).toBe('localhost:3005');
        expect(derivePresentableRelayHost('https://relay.example.test:8443')).toBe('relay.example.test:8443');
    });

    it('falls back to the canonical display rather than showing nothing', () => {
        expect(derivePresentableRelayHost('not a url')).toBeNull();
        expect(toRelayHostDisplay('not a url')).toBe('');
        expect(toRelayHostDisplay('api.happier.dev')).toBe('api.happier.dev');
    });
});
