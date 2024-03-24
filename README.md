# vite-plugin-auto-cert
 
Generate a temporary certificate from trusted ca, and start a vite dev server with https enable.

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

Insert example below into your vite config's plugin section.

```typescript
autoCert({
  ca: {
    cert: "<provide your ca's cert>",
    key: "<provide your ca's private key>",
  },
});
```
