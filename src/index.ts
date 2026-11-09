import forge from "node-forge";
import os from "os";
import fs from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";
import { Plugin } from 'vite';

type TCertificateAuthority = { cert: string, key: string };

export type TPluginOptions = {
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

/**
 * 从 PEM 文本中按出现顺序抽取全部证书块。
 */
const splitPemCertificates = (pem: string): string[] => {
  const matches = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  return matches ? matches.map((block) => block.trim()) : [];
};

/**
 * 判断证书是否自签名：用证书自身公钥验证自身签名。
 */
const isSelfSignedCertificate = (cert: forge.pki.Certificate): boolean => {
  try {
    return cert.verify(cert);
  } catch {
    return false;
  }
};

/**
 * 判断证书公钥是否与给定私钥配对：比较 RSA 模数 n 的十六进制串。
 */
const publicKeyMatches = (cert: forge.pki.Certificate, privateKey: forge.pki.rsa.PrivateKey): boolean => {
  const certPublicKey = cert.publicKey as forge.pki.rsa.PublicKey;
  if (!certPublicKey || !certPublicKey.n || !privateKey || !privateKey.n) {
    return false;
  }
  return certPublicKey.n.toString(16).toLowerCase() === privateKey.n.toString(16).toLowerCase();
};

const getCommonName = (attributes: forge.pki.CertificateField[]): string => {
  const commonName = attributes.find((attribute) => attribute.name === 'commonName' || attribute.shortName === 'CN');
  return typeof commonName?.value === 'string' ? commonName.value : '';
};

/**
 * 比较两组证书名称属性是否等价（忽略属性顺序）。
 */
const attributesEqual = (a: forge.pki.CertificateField[], b: forge.pki.CertificateField[]): boolean => {
  const canonical = (attributes: forge.pki.CertificateField[]): string => attributes
    .map((attribute) => `${attribute.name ?? attribute.shortName ?? ''}=${String(attribute.value ?? '')}`)
    .sort()
    .join('|');
  return canonical(a) === canonical(b);
};

const generateCert = (ca: TCertificateAuthority, ipAddresses: string[]) => {
  const pki = forge.pki;
  const blocks = splitPemCertificates(ca.cert);
  if (blocks.length === 0) {
    throw new Error('[auto-cert] ca.cert / ca.certFile 中未找到任何 CERTIFICATE 证书块，请确认内容为 PEM 格式');
  }

  const caKey = pki.privateKeyFromPem(ca.key);
  const certs = blocks.map((block) => pki.certificateFromPem(block));
  // 以公钥匹配定位真正负责签发的 CA，cert 内证书顺序不限。
  const signingCa = certs.find((cert) => publicKeyMatches(cert, caKey));
  if (!signingCa) {
    throw new Error('[auto-cert] 证书链中找不到与私钥匹配的 CA 证书，请确认 ca.key 与 ca.cert 中的某张证书配对');
  }

  const tlsKeyPair = pki.rsa.generateKeyPair(2048);
  const tlsCert = pki.createCertificate();
  tlsCert.publicKey = tlsKeyPair.publicKey;
  tlsCert.serialNumber = generateSerialNumber();
  tlsCert.validity.notBefore = new Date();
  tlsCert.validity.notAfter = new Date();
  tlsCert.validity.notAfter.setFullYear(tlsCert.validity.notAfter.getFullYear() + 1);
  tlsCert.setSubject([{name: 'commonName', value: 'vite dev cert'}]);
  tlsCert.setIssuer(signingCa.subject.attributes);
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
  // 每次签名都新建 digest 对象，避免复用同一个 MessageDigest 导致签名错误。
  tlsCert.sign(caKey, forge.md.sha256.create());

  // 构建中间证书链：从签发 CA 向上按 issuer -> subject 串联，直到自签名根（根不下发）。
  const chain: forge.pki.Certificate[] = [];
  const usedPems = new Set<string>();
  let current: forge.pki.Certificate = signingCa;
  let reachedRoot = false;
  let rootCn = '';
  if (isSelfSignedCertificate(signingCa)) {
    // 根直签：签发 CA 本身就是自签名根，无中间证书。
    reachedRoot = true;
    rootCn = getCommonName(signingCa.subject.attributes);
  } else {
    chain.push(signingCa);
    usedPems.add(pki.certificateToPem(signingCa));
  }
  while (!reachedRoot) {
    const next = certs.find((candidate) => {
      if (usedPems.has(pki.certificateToPem(candidate))) {
        return false;
      }
      return attributesEqual(candidate.subject.attributes, current.issuer.attributes);
    });
    if (!next) {
      // 链不完整：找不到 current 的上级证书。
      break;
    }
    if (isSelfSignedCertificate(next)) {
      // 到达自签名根：根不下发，链到此为止。
      reachedRoot = true;
      rootCn = getCommonName(next.subject.attributes);
      break;
    }
    chain.push(next);
    usedPems.add(pki.certificateToPem(next));
    current = next;
  }

  const chainPem = chain.map((cert) => pki.certificateToPem(cert));
  const servedCert = [pki.certificateToPem(tlsCert), ...chainPem].join('\n');
  return {
    cert: servedCert,
    publicKey: pki.publicKeyToPem(tlsKeyPair.publicKey),
    privateKey: pki.privateKeyToPem(tlsKeyPair.privateKey),
    intermediateCount: chain.length,
    reachedRoot,
    topCn: reachedRoot ? rootCn : getCommonName(current.subject.attributes),
    missingIssuerCn: reachedRoot ? undefined : getCommonName(current.issuer.attributes),
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
      if ((options as any).ca !== undefined) {
        throw new Error('[auto-cert] 自 2.0.0 起不再支持 autoCert({ ca }) 内联 CA，请在项目根使用 auto-cert.config.yaml 提供 CA（详见 README）');
      }

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

      // CA 只能来自项目配置文件；没有可用的配置文件即 no-op。
      const ca = configFilePath && configFile && configFile.enabled !== false
        ? loadCaFromConfigFile(configFilePath, configFile)
        : undefined;

      if (!ca) {
        if (!configFilePath) {
          announceOnce(`[auto-cert] 未找到配置文件（查找 ${DEFAULT_CONFIG_FILE_NAMES.join(' / ')}，根目录：${root}），插件未启用`);
        } else {
          announceOnce(`[auto-cert] 配置文件 ${configFilePath} 中 enabled 为 false，插件未启用`);
        }
        return undefined;
      }

      const tls = generateCert(ca, getLocalIPv4Addresses());
      if (tls.intermediateCount > 0) {
        if (tls.reachedRoot) {
          announceOnce(`[auto-cert] 签发 CA 为中间 CA，已下发 ${tls.intermediateCount} 张中间证书，证书链已完整追溯至根 CA「${tls.topCn}」`);
        } else {
          // 未包含根证书是正常情况：根不下发、由客户端信任，不判为“链不完整”。
          // 这里只提示链顶端 CA 及其需被信任的上级，便于用户判断是否还缺中间证书。
          announceOnce(`[auto-cert] 签发 CA 为中间 CA，已下发 ${tls.intermediateCount} 张中间证书；证书链顶端为中间 CA「${tls.topCn}」，其上级为「${tls.missingIssuerCn}」。若客户端只信任根证书，请确保从「${tls.topCn}」到根的各级中间 CA 证书都已放入 ca.cert / certFile（若「${tls.missingIssuerCn}」即根，则当前链已足够）`);
        }
      } else {
        announceOnce('[auto-cert] 签发 CA 为自签名根 CA，已直接签发叶子证书');
      }
      return {
        server: {
          https: {cert: tls.cert, key: tls.privateKey},
        },
      };
    },
  };
};

export default autoCert;
