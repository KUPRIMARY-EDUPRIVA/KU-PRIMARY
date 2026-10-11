const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const separator = key.indexOf('=');
    if (separator !== -1) {
        options[key.slice(2, separator)] = key.slice(separator + 1);
    } else {
        options[key.slice(2)] = args[++index];
    }
}

const initialCapacitorConfig = JSON.parse(
    fs.readFileSync(path.join(root, 'capacitor.config.json'), 'utf8')
);
options['firebase-config'] ||= 'google-services.json';
options['app-name'] ||= initialCapacitorConfig.appName;
options['package-id'] ||= initialCapacitorConfig.appId;
options['signing-properties'] ||= 'SIGNED APPS/signing.properties';
options['functions-origin'] ||= process.env.REACT_APP_NETLIFY_FUNCTIONS_ORIGIN
    || `https://${initialCapacitorConfig.server?.allowNavigation?.[0] || 'kiwanjapri.netlify.app'}`;
options.output ||= 'Reads.apk';
const outputPath = path.resolve(root, options.output);
if (!outputPath.startsWith(`${root}${path.sep}`) || !outputPath.toLowerCase().endsWith('.apk')) {
    throw new Error('--output must be an APK path within the repository.');
}

const firebasePath = path.resolve(root, options['firebase-config']);
if (!firebasePath.startsWith(`${root}${path.sep}`) || !fs.existsSync(firebasePath)) {
    throw new Error(`Firebase config not found within the repository: ${options['firebase-config']}`);
}
const signingPropertiesPath = path.resolve(root, options['signing-properties']);
if (!signingPropertiesPath.startsWith(`${root}${path.sep}`) || !fs.existsSync(signingPropertiesPath)) {
    throw new Error(`Signing properties not found within the repository: ${options['signing-properties']}`);
}
const functionsUrl = new URL(options['functions-origin']);
if (functionsUrl.protocol !== 'https:' && functionsUrl.hostname !== 'localhost') {
    throw new Error('Netlify Functions origin must use HTTPS.');
}
const functionsOrigin = `${functionsUrl.origin}${functionsUrl.pathname.replace(/\/+$/, '')}`
    .replace(/\/(?:\.netlify\/)?functions$/i, '');
const functionsBase = `${functionsOrigin}/.netlify/functions`;

const configPath = path.join(root, 'capacitor.config.json');
const androidGoogleServicesPath = path.join(root, 'android/app/google-services.json');
const appStringsPath = path.join(root, 'android/app/src/main/res/values/strings.xml');
const appGradlePath = path.join(root, 'android/app/build.gradle');
const manifestPath = path.join(root, 'public/manifest.json');
const restorePaths = [
    configPath,
    androidGoogleServicesPath,
    appStringsPath,
    appGradlePath,
    manifestPath,
];
const snapshots = new Map(restorePaths.map((filePath) => [
    filePath,
    fs.existsSync(filePath) ? fs.readFileSync(filePath) : null,
]));

function restoreProjectFiles() {
    for (const [filePath, contents] of snapshots) {
        if (contents === null) {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } else {
            fs.writeFileSync(filePath, contents);
        }
    }
}

function run(command, commandArgs, cwd = root, env = process.env) {
    const result = spawnSync(command, commandArgs, { cwd, env, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`);
    }
}

function resolveFunctionsOrigin(config) {
    const functions = new URL(functionsBase);
    config.server = {
        ...config.server,
        allowNavigation: [
            ...new Set([
                ...(config.server?.allowNavigation || []).filter(
                    (host) => !String(host).endsWith('.netlify.app')
                ),
                functions.hostname,
            ]),
        ],
    };
}

function setAndroidAppLabel(appName) {
    const escapeXml = (value) => value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    const escapedName = escapeXml(appName);
    let strings = fs.readFileSync(appStringsPath, 'utf8');
    for (const key of ['app_name', 'title_activity_main']) {
        const matcher = new RegExp(`(<string name="${key}">)[\\s\\S]*?(</string>)`);
        if (!matcher.test(strings)) throw new Error(`Android string ${key} is missing.`);
        strings = strings.replace(matcher, `$1${escapedName}$2`);
    }
    fs.writeFileSync(appStringsPath, strings);
}

function setAndroidPackageId(packageId) {
    let gradle = fs.readFileSync(appGradlePath, 'utf8');
    const matcher = /^(\s*applicationId\s+")([^"]+)(")/m;
    if (!matcher.test(gradle)) throw new Error('Android applicationId is missing from build.gradle.');
    gradle = gradle.replace(matcher, `$1${packageId}$3`);
    fs.writeFileSync(appGradlePath, gradle);

    let strings = fs.readFileSync(appStringsPath, 'utf8');
    for (const key of ['package_name', 'custom_url_scheme']) {
        const stringMatcher = new RegExp(`(<string name="${key}">)[\\s\\S]*?(</string>)`);
        if (!stringMatcher.test(strings)) throw new Error(`Android string ${key} is missing.`);
        strings = strings.replace(stringMatcher, `$1${packageId}$2`);
    }
    fs.writeFileSync(appStringsPath, strings);
}

function build() {
    const capacitorConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const firebaseConfig = JSON.parse(fs.readFileSync(firebasePath, 'utf8'));
    const packageId = options['package-id'];
    const project = firebaseConfig.project_info;
    const client = firebaseConfig.client?.find(
        ({ client_info }) => client_info.android_client_info.package_name === packageId
    );
    if (!client) throw new Error(`Firebase config does not contain the Android package ${packageId}`);

    const exampleEnv = fs.existsSync(path.join(root, '.env-example'))
        ? fs.readFileSync(path.join(root, '.env-example'), 'utf8')
            .split(/\r?\n/)
            .reduce((values, line) => {
                const separator = line.indexOf('=');
                if (separator > 0 && !line.startsWith('#')) {
                    values[line.slice(0, separator)] = line.slice(separator + 1);
                }
                return values;
            }, {})
        : {};
    const webAppId = exampleEnv.REACT_APP_FIREBASE_APP_ID;
    const firebaseAppId = webAppId?.startsWith(`1:${project.project_number}:web:`)
        ? webAppId
        : client.client_info.mobilesdk_app_id;
    const apiKey = client.api_key?.[0]?.current_key;
    if (!apiKey) throw new Error('Firebase Android API key is missing from google-services config');

    capacitorConfig.appName = options['app-name'];
    capacitorConfig.appId = packageId;
    resolveFunctionsOrigin(capacitorConfig);
    fs.writeFileSync(configPath, `${JSON.stringify(capacitorConfig, null, 2)}\n`);
    setAndroidAppLabel(options['app-name']);
    setAndroidPackageId(packageId);
    fs.copyFileSync(firebasePath, androidGoogleServicesPath);

    const java21 = '/usr/local/sdkman/candidates/java/21.0.12+1-ms';
    const env = {
        ...process.env,
        EDUPRIVA_SIGNING_PROPERTIES: signingPropertiesPath,
        ANDROID_HOME: process.env.ANDROID_HOME || path.join(os.homedir(), '.android-sdk'),
        ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), '.android-sdk'),
        JAVA_HOME: process.env.EDUPRIVA_BUILD_JAVA_HOME
            || (fs.existsSync(java21) ? java21 : process.env.JAVA_HOME),
        REACT_APP_FIREBASE_API_KEY: apiKey,
        REACT_APP_FIREBASE_AUTH_DOMAIN: `${project.project_id}.firebaseapp.com`,
        REACT_APP_FIREBASE_PROJECT_ID: project.project_id,
        REACT_APP_FIREBASE_STORAGE_BUCKET: project.storage_bucket,
        REACT_APP_FIREBASE_MESSAGING_SENDER_ID: project.project_number,
        REACT_APP_FIREBASE_APP_ID: firebaseAppId,
        REACT_APP_NETLIFY_FUNCTIONS_ORIGIN: functionsBase,
    };

    run('npx', [
        '@capacitor/assets', 'generate', '--android', '--pwa',
        '--assetPath', 'assets',
        '--pwaManifestPath', 'public/manifest.json',
        '--iconBackgroundColor', '#f5f7fb',
        '--splashBackgroundColor', '#f5f7fb',
    ], root, env);

    const generatedIconsPath = path.join(root, 'icons');
    const publicIconsPath = path.join(root, 'public/icons');
    fs.mkdirSync(publicIconsPath, { recursive: true });
    for (const icon of fs.readdirSync(generatedIconsPath)) {
        fs.renameSync(path.join(generatedIconsPath, icon), path.join(publicIconsPath, icon));
    }
    fs.rmdirSync(generatedIconsPath);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.icons = manifest.icons.map((icon) => ({
        ...icon,
        src: `/icons/${path.basename(icon.src)}`,
        type: 'image/webp',
    }));
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    run('npm', ['run', 'build'], root, env);
    run('npx', ['cap', 'sync', 'android'], root, env);
    run('./gradlew', ['assembleRelease'], path.join(root, 'android'), env);

    const apkPath = path.join(root, 'android/app/build/outputs/apk/release/app-release.apk');
    if (!fs.existsSync(apkPath)) throw new Error(`Release APK was not produced at ${apkPath}`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.copyFileSync(apkPath, outputPath);
    console.log(`Signed APK copied to ${outputPath}`);
}

try {
    build();
} finally {
    restoreProjectFiles();
}
