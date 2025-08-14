import { devices } from 'playwright';

/**
 * List all available device profiles for emulation
 */
export function listAvailableDevices() {
  const deviceList = Object.keys(devices).sort();
  
  const categories = {
    iPhones: [] as string[],
    iPads: [] as string[],
    Android: [] as string[],
    Desktop: [] as string[],
    Other: [] as string[]
  };
  
  deviceList.forEach(device => {
    if (device.includes('iPhone')) {
      categories.iPhones.push(device);
    } else if (device.includes('iPad')) {
      categories.iPads.push(device);
    } else if (device.includes('Pixel') || device.includes('Galaxy') || device.includes('Android')) {
      categories.Android.push(device);
    } else if (device.includes('Desktop')) {
      categories.Desktop.push(device);
    } else {
      categories.Other.push(device);
    }
  });
  
  return categories;
}

/**
 * Get device details for a specific device
 */
export function getDeviceDetails(deviceName: string) {
  const device = devices[deviceName];
  if (!device) {
    return null;
  }
  
  return {
    name: deviceName,
    viewport: device.viewport,
    userAgent: device.userAgent,
    isMobile: device.isMobile,
    hasTouch: device.hasTouch,
    deviceScaleFactor: device.deviceScaleFactor
  };
}

// Common mobile devices for testing
export const COMMON_DEVICES = {
  mobile: [
    'iPhone 14',
    'iPhone 14 Pro',
    'iPhone 14 Pro Max',
    'iPhone SE',
    'Pixel 7',
    'Galaxy S9+',
    'iPad',
    'iPad Pro'
  ],
  desktop: [
    'Desktop Chrome',
    'Desktop Firefox', 
    'Desktop Safari',
    'Desktop Edge'
  ]
};