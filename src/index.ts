import forge from "node-forge";
import os from "os";
import { Plugin } from 'vite';

export type TPluginOptions = {
  ca: { cert: string, key: string }
}

const hasIPv4Address = (item: os.NetworkInterfaceInfo | undefined): boolean => item?.family === 'IPv4';

const getLocalIPv4Addresses = (): string[] => Object.values(os.networkInterfaces())
  .flat()
  .filter(hasIPv4Address)
  .map((item) => (<os.NetworkInterfaceInfo>item).address);

const generateCert = (options: TPluginOptions, ipAddresses: string[]) => {
  const pki = forge.pki;
  const caCert = pki.certificateFromPem(options.ca.cert);
  const caKey = pki.privateKeyFromPem(options.ca.key);
  const tlsKeyPair = pki.rsa.generateKeyPair(2048);
  const tlsCert = pki.createCertificate();
  tlsCert.publicKey = tlsKeyPair.publicKey;
  tlsCert.serialNumber = '01';
  tlsCert.validity.notBefore = new Date();
  tlsCert.validity.notAfter = new Date();
  tlsCert.validity.notAfter.setFullYear(tlsCert.validity.notAfter.getFullYear() + 1);
  tlsCert.setSubject([{name: 'commonName', value: 'vite dev cert'}]);
  tlsCert.setIssuer(caCert.subject.attributes);
  tlsCert.setExtensions([{
    name: 'basicConstraints',
    cA: false,
  }, {
    name: 'keyUsage',
    keyCertSign: false,
    digitalSignature: true,
    nonRepudiation: false,
    keyEncipherment: true,
    dataEncipherment: false,
  }, {
    name: 'subjectAltName',
    altNames: [{type: 2, value: 'localhost'}, ...ipAddresses.map(address => ({type: 7, ip: address}))],
  }, {
    name: 'authorityKeyIdentifier',
    keyIdentifier: true,
    issuer: true,
  }]);
  tlsCert.sign(caKey, forge.md.sha256.create());
  return {
    cert: pki.certificateToPem(tlsCert),
    publicKey: pki.publicKeyToPem(tlsKeyPair.publicKey),
    privateKey: pki.privateKeyToPem(tlsKeyPair.privateKey),
  };
};

const autoCert = (options: TPluginOptions): Plugin => ({
  name: 'auto-cert',
  apply: 'serve',
  config: () => {
    const tls = generateCert(options, getLocalIPv4Addresses());
    return {
      server: {
        https: {cert: tls.cert, key: tls.privateKey},
      },
    };
  },
});

export default autoCert;
