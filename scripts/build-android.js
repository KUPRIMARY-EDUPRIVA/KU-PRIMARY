const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const packageId = 'com.EDUPRIVAKU';
const java21 = '/usr/local/sdkman/candidates/java/21.0.12+1-ms';
const googleServicesPath = path.join(root, 'google-services.json');
const googleServices = JSON.parse(fs.readFileSync(googleServicesPath, 'utf8'));
const project = googleServices.project_info;
const client = googleServices.client.find(
    ({ client_info }) => client_info.android_client_info.package_name === packageId
);

if (!client) {
    throw new Error(`Firebase config does not contain the Android package ${packageId}`);
}

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

const env = {
    ...process.env,
    ANDROID_HOME: process.env.ANDROID_HOME || path.join(os.homedir(), '.android-sdk'),
    ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), '.android-sdk'),
    JAVA_HOME: process.env.EDUPRIVA_BUILD_JAVA_HOME
        || (fs.existsSync(java21) ? java21 : process.env.JAVA_HOME),
    REACT_APP_FIREBASE_API_KEY: apiKey,
    REACT_APP_FIREBASE_AUTH_DOMAIN: `${project.project_id}.firebaseapp.com`,
    REACT_APP_FIREBASE_PROJECT_ID: project.project_id,
    REACT_APP_FIREBASE_STORAGE_BUCKET: project.storage_bucket,
    REACT_APP_FIREBASE_MESSAGING_SENDER_ID: project.project_number,
    REACT_APP_FIREBASE_APP_ID: firebaseAppId
};

function run(command, args, cwd = root) {
    const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
}

run('npx', [
    '@capacitor/assets',
    'generate',
    '--android',
    '--pwa',
    '--assetPath',
    'assets',
    '--pwaManifestPath',
    'public/manifest.json',
    '--iconBackgroundColor',
    '#f5f7fb',
    '--splashBackgroundColor',
    '#f5f7fb'
]);
const generatedIconsPath = path.join(root, 'icons');
const publicIconsPath = path.join(root, 'public/icons');
fs.mkdirSync(publicIconsPath, { recursive: true });
for (const icon of fs.readdirSync(generatedIconsPath)) {
    fs.renameSync(path.join(generatedIconsPath, icon), path.join(publicIconsPath, icon));
}
fs.rmdirSync(generatedIconsPath);

const manifestPath = path.join(root, 'public/manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.icons = manifest.icons.map((icon) => ({
    ...icon,
    src: `/icons/${path.basename(icon.src)}`,
    type: 'image/webp'
}));
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

fs.copyFileSync(googleServicesPath, path.join(root, 'android/app/google-services.json'));
run('npm', ['run', 'build']);
run('npx', ['cap', 'sync', 'android']);
run('./gradlew', ['assembleRelease'], path.join(root, 'android'));

const apkPath = path.join(root, 'android/app/build/outputs/apk/release/app-release.apk');
const outputPath = path.join(root, 'ROLE3.apk');
if (!fs.existsSync(apkPath)) throw new Error(`Release APK was not produced at ${apkPath}`);
fs.copyFileSync(apkPath, outputPath);
console.log(`Signed APK copied to ${outputPath}`);
