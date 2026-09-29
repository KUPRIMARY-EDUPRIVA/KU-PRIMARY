import { Capacitor, registerPlugin } from '@capacitor/core';

const DeviceSms = registerPlugin('DeviceSms');

export const isDeviceSmsAvailable = () =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

export async function requestSmsPermissions() {
  if (!isDeviceSmsAvailable()) {
    throw new Error('SIM-based SMS is available only in the Android app.');
  }
  const result = await DeviceSms.requestPermissions();
  if (!result.granted) {
    throw new Error('SMS and SIM access permissions are required to send messages.');
  }
}

export async function getDeviceSims() {
  if (!isDeviceSmsAvailable()) {
    throw new Error('SIM detection is available only in the Android app.');
  }
  return DeviceSms.getSims();
}

export async function sendDeviceSms({ phoneNumber, message, subscriptionId }) {
  if (!isDeviceSmsAvailable()) {
    throw new Error('SIM-based SMS is available only in the Android app.');
  }
  return DeviceSms.sendSms({ phoneNumber, message, subscriptionId });
}
