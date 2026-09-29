import { Capacitor, registerPlugin } from '@capacitor/core';

const DeviceSecurity = registerPlugin('DeviceSecurity');

export const isDeviceBiometricAvailable = () =>
    Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

export async function getBiometricLoginStatus() {
    if (!isDeviceBiometricAvailable()) return { available: false, enabled: false };
    return DeviceSecurity.getBiometricStatus();
}

export async function authenticateWithBiometrics() {
    if (!isDeviceBiometricAvailable()) {
        throw new Error('Biometric login is available only in the Android app.');
    }
    return DeviceSecurity.authenticate();
}

export async function saveBiometricCredentials(email, password) {
    if (!isDeviceBiometricAvailable()) {
        throw new Error('Biometric login is available only in the Android app.');
    }
    return DeviceSecurity.saveCredentials({ email, password });
}

export async function savePdfBlob(blob, filename) {
    if (isDeviceBiometricAvailable()) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        const chunkSize = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
        }
        return DeviceSecurity.savePdf({
            filename,
            base64: btoa(binary)
        });
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { filename };
}
