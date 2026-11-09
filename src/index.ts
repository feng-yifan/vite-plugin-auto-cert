import forge from "node-forge";
import os from "os";
import fs from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";
import { Plugin } from 'vite';

export type TCertificateAuthority = { cert: string, key: string };

export type TPluginOptions = {
  /**
   * 显式内联的 CA 证书与私钥，优先级最高（保留 1.0.x 的用法）。
   */
  ca?: TCertificateAuthority,
  /**
   * 配置文件名或路径，相对 vite root 解析。
   * 默认在项目根查找 auto-cert.config.yaml，找不到再试 auto-cert.config.yml。
   */
  configFile?: string,
}

type TConfigFileCa = {
  cert?: string,
  key?: string,
  certFile?: string,
  keyFile?: string,
}

type TConfigFile = {
  enabled?: boolean,
  ca?: TConfigFileCa,
}

const DEFAULT_CONFIG_FILE_NAMES = ['auto-cert.config.yaml', 'auto-cert.config.yml'];

const hasIPv4Address = (item: os.NetworkInterfaceInfo | undefined): boolean => item?.family === 'IPv4';

const getLocalIPv4Addresses = (): string[] => Object.values(os.networkInterfaces())
  .flat()
  .filter(hasIPv4Address)
  .map((item) => (<os.NetworkInterfaceInfo>item).address);

/**
 * 生成叶子证书的序列号：16 字节随机数转十六进制。
 * 若首字节最高位为 1，则补 '00' 前缀，保证 DER INTEGER 为正数。
 */
const generateSerialNumber = (): string => {
  const hex = forge.util.bytesToHex(forge.random.getBytesSync(16));
  return parseInt(hex.slice(0, 2), 16) >= 0x80 ? `00${hex}` : hex;
};

const generateCert = (ca: TCertificateAuthority, ipAddresses: string[]) => {
  const pki = forge.pki;
  const caCert = pki.certificateFromPem(ca.cert);
  const caKey = pki.privateKeyFromPem(ca.key);
  const tlsKeyPair = pki.rsa.generateKeyPair(2048);
  const tlsCert = pki.createCertificate();
  tlsCert.publicKey = tlsKeyPair.publicKey;
  tlsCert.serialNumber = generateSerialNumber();
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
    name: 'subjectKeyIdentifier',
  }]);
  tlsCert.sign(caKey, forge.md.sha256.create());
  return {
    cert: pki.certificateToPem(tlsCert),
    publicKey: pki.publicKeyToPem(tlsKeyPair.publicKey),
    privateKey: pki.privateKeyToPem(tlsKeyPair.privateKey),
  };
};

/**
 * 在 vite root 下解析配置文件路径：
 * - 显式传入 configFile 时按其相对 root 解析（绝对路径原样使用），文件不存在返回 undefined；
 * - 否则依次尝试 auto-cert.config.yaml / auto-cert.config.yml。
 */
const resolveConfigFilePath = (root: string, configFile?: string): string | undefined => {
  if (configFile) {
    const fullPath = path.resolve(root, configFile);
    return fs.existsSync(fullPath) ? fullPath : undefined;
  }
  for (const fileName of DEFAULT_CONFIG_FILE_NAMES) {
    const fullPath = path.join(root, fileName);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }
  return undefined;
};

const resolveCaField = (
  configFilePath: string,
  inline: string | undefined,
  fileRef: string | undefined,
  fieldName: 'cert' | 'key',
): string => {
  if (typeof inline === 'string' && inline.trim()) {
    return inline;
  }
  if (typeof fileRef === 'string' && fileRef.trim()) {
    const fullPath = path.resolve(path.dirname(configFilePath), fileRef);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`[auto-cert] 配置文件引用的 CA ${fieldName} 文件不存在：${fullPath}（配置文件：${configFilePath}）`);
    }
    return fs.readFileSync(fullPath, 'utf8');
  }
  throw new Error(`[auto-cert] 配置文件的 ca 缺少 ${fieldName}（需要内联 ${fieldName} 或提供 ${fieldName}File）：${configFilePath}`);
};

const loadCaFromConfigFile = (configFilePath: string, configFile: TConfigFile): TCertificateAuthority => {
  const ca = configFile.ca;
  if (!ca || typeof ca !== 'object') {
    throw new Error(`[auto-cert] 配置文件中缺少 ca 配置：${configFilePath}`);
  }
  return {
    cert: resolveCaField(configFilePath, ca.cert, ca.certFile, 'cert'),
    key: resolveCaField(configFilePath, ca.key, ca.keyFile, 'key'),
  };
};

const autoCert = (options: TPluginOptions = {}): Plugin => {
  let announced = false;
  const announceOnce = (message: string) => {
    if (!announced) {
      console.info(message);
      announced = true;
    }
  };

  return {
    name: 'auto-cert',
    apply: 'serve',
    config: (userConfig) => {
      const root = userConfig.root ? path.resolve(process.cwd(), userConfig.root) : process.cwd();
      const configFilePath = resolveConfigFilePath(root, options.configFile);

      let configFile: TConfigFile | undefined;
      if (configFilePath) {
        const raw = fs.readFileSync(configFilePath, 'utf8');
        try {
          configFile = parseYaml(raw) as TConfigFile;
        } catch (error) {
          throw new Error(`[auto-cert] 配置文件 YAML 解析失败：${configFilePath}：${(error as Error).message}`);
        }
        if (configFile === null || typeof configFile !== 'object') {
          throw new Error(`[auto-cert] 配置文件内容无效（期望 YAML 对象）：${configFilePath}`);
        }
      }

      // 优先级：显式 autoCert({ ca }) > 配置文件 > no-op
      const ca = options.ca ?? (
        configFilePath && configFile && configFile.enabled !== false
          ? loadCaFromConfigFile(configFilePath, configFile)
          : undefined
      );

      if (!ca) {
        if (!configFilePath) {
          announceOnce(`[auto-cert] 未找到配置文件（查找 ${DEFAULT_CONFIG_FILE_NAMES.join(' / ')}，根目录：${root}），插件未启用`);
        } else {
          announceOnce(`[auto-cert] 配置文件 ${configFilePath} 中 enabled 为 false，插件未启用`);
        }
        return undefined;
      }

      const tls = generateCert(ca, getLocalIPv4Addresses());
      return {
        server: {
          https: {cert: tls.cert, key: tls.privateKey},
        },
      };
    },
  };
};

export default autoCert;
