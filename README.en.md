[简体中文](README.md) | **English**

# vite-plugin-auto-cert

Generate a temporary certificate signed by your trusted CA, and start a Vite dev server with HTTPS enabled.

## The reasons you may need this plugin

1. To test functions which require https connection
2. You want to start an https dev server for multiple projects but are tired of trusting certificates over and over again
3. You want to share your projects in programing with your teammates

## Plugin behavior

This plugin will rewrite the `server.https` section in your vite config, and force to start https server

1. get all your device's ipv4 addresses
2. sign a cert for these addresses and `localhost`
3. start dev server with these addresses and `localhost`

## Usage

### Project config file

Create `auto-cert.config.yaml` in your **project root** (the `root` passed to Vite; falls back to
`process.cwd()`). If `auto-cert.config.yaml` is not found, the plugin also tries
`auto-cert.config.yml`.

```yaml
enabled: true # optional, defaults to true; set false to disable the plugin (no-op)
ca:
  # inline PEM (both cert and key are required)
  cert: |
    -----BEGIN CERTIFICATE-----
    ...
    -----END CERTIFICATE-----
  key: |
    -----BEGIN PRIVATE KEY-----
    ...
    -----END PRIVATE KEY-----
  # or file paths, resolved relative to the directory of this config file:
  # certFile: ./certs/ca.crt
  # keyFile: ./certs/ca.key
```

See [`auto-cert.config.example.yaml`](./auto-cert.config.example.yaml) for a safe, secret-free example.

Then add the plugin to your vite config (no CA secrets in `vite.config.ts`):

```typescript
import autoCert from "vite-plugin-auto-cert";

export default defineConfig({
  plugins: [autoCert()],
});
```

You can override the config file name or path with the `configFile` option (relative to `root`):

```typescript
autoCert({ configFile: "config/auto-cert.yaml" });
```

## Using in a monorepo

The plugin looks for `auto-cert.config.yaml` under Vite's `root` (falling back to
`process.cwd()` when `root` is not set). Therefore:

- If each package starts Vite from its own directory (e.g. `pnpm --filter <pkg> dev`, or
  turbo/nx running in each package folder), each package finds its own config independently
  and works normally.
- If you start Vite from the monorepo root with `vite --config packages/web/vite.config.ts`
  and that package's Vite config does not set `root`, the plugin looks in the repository root,
  cannot find a config, and becomes a no-op (starts over HTTP).

To point the plugin at the right package, use any of:
1. start Vite inside each package directory (most common);
2. set `root` to the package's own directory in that package's Vite config;
3. pass `autoCert({ configFile: "packages/web/auto-cert.config.yaml" })` in that package's Vite
   config (path relative to Vite root / cwd, or absolute).

## Behavior details

- **Config file not found → no-op.** The plugin returns `undefined` from the `config` hook and does
  not touch `server.https`; Vite starts with its original configuration. A single
  `[auto-cert] ... 未找到 ...，插件未启用` info line is printed.
- **Config file found → generate a certificate from it and set `server.https`.**
- **The CA comes only from the project config file:** with no config file the plugin is a no-op;
  passing `autoCert({ ca })` throws an error (see above).
- **`enabled: false` in the config file** is treated as a no-op (no error).
- **Invalid config file** (YAML parse error, missing `ca`, incomplete `cert`/`key`, or a referenced
  cert/key file that does not exist) throws an error that includes the file path, so Vite fails to
  start instead of silently falling back.

## Security: keep your CA private key out of git

Add the config file and the referenced certificate directory to `.gitignore`, and restrict the CA
private key permissions:

```gitignore
# .gitignore
auto-cert.config.yaml
auto-cert.config.yml
certs/
```

```bash
chmod 600 certs/ca.key
```
