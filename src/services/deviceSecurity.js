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

export async function enableBiometricUnlock() {
    if (!isDeviceBiometricAvailable()) {
        throw new Error('Biometric unlock is available only in the Android app.');
    }
    return DeviceSecurity.enableBiometricUnlock();
}

export async function savePdfBlob(blob, filename) {
    if (!(blob instanceof Blob) || blob.size === 0) {
        throw new Error('The PDF export is empty and was not saved.');
    }

    if (isDeviceBiometricAvailable()) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (bytes.length < 5 || String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') {
            throw new Error('The PDF export is invalid and was not saved.');
        }
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
