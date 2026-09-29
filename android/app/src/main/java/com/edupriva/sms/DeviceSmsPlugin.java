package com.edupriva.sms;

import android.Manifest;
import android.telephony.SmsManager;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;
import android.text.TextUtils;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.List;

@CapacitorPlugin(
    name = "DeviceSms",
    permissions = {
        @Permission(
            alias = "sms",
            strings = {
                Manifest.permission.SEND_SMS,
                Manifest.permission.READ_PHONE_STATE
            }
        )
    }
)
public class DeviceSmsPlugin extends Plugin {
    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (hasRequiredPermissions()) {
            resolveGranted(call);
            return;
        }
        requestPermissionForAlias("sms", call, "permissionResult");
    }

    @PermissionCallback
    private void permissionResult(PluginCall call) {
        if (hasRequiredPermissions()) {
            resolveGranted(call);
        } else {
            JSObject result = new JSObject();
            result.put("granted", false);
            call.resolve(result);
        }
    }

    @PluginMethod
    public void getSims(PluginCall call) {
        if (!hasRequiredPermissions()) {
            call.reject("Grant SMS and phone permissions before detecting SIM cards.");
            return;
        }

        try {
            SubscriptionManager manager = getContext().getSystemService(SubscriptionManager.class);
            List<SubscriptionInfo> subscriptions = manager == null
                ? null
                : manager.getActiveSubscriptionInfoList();
            JSArray sims = new JSArray();

            if (subscriptions != null) {
                for (SubscriptionInfo subscription : subscriptions) {
                    JSObject sim = new JSObject();
                    sim.put("subscriptionId", subscription.getSubscriptionId());
                    sim.put("slotIndex", subscription.getSimSlotIndex());
                    sim.put("displayName", TextUtils.isEmpty(subscription.getDisplayName())
                        ? "SIM " + (subscription.getSimSlotIndex() + 1)
                        : subscription.getDisplayName().toString());
                    CharSequence carrier = subscription.getCarrierName();
                    sim.put("carrierName", carrier == null ? "" : carrier.toString());
                    sims.put(sim);
                }
            }

            JSObject result = new JSObject();
            result.put("sims", sims);
            call.resolve(result);
        } catch (SecurityException exception) {
            call.reject("Android denied access to the phone's SIM cards.", exception);
        } catch (Exception exception) {
            call.reject("Unable to detect SIM cards.", exception);
        }
    }

    @PluginMethod
    public void sendSms(PluginCall call) {
        if (!hasRequiredPermissions()) {
            call.reject("Grant SMS and phone permissions before sending messages.");
            return;
        }

        String phoneNumber = call.getString("phoneNumber");
        String message = call.getString("message");
        Integer subscriptionId = call.getInt("subscriptionId");
        if (TextUtils.isEmpty(phoneNumber) || TextUtils.isEmpty(message) || subscriptionId == null) {
            call.reject("A phone number, message, and SIM are required.");
            return;
        }

        try {
            SmsManager manager = getContext().getSystemService(SmsManager.class);
            if (manager == null) {
                call.reject("Android SMS service is unavailable.");
                return;
            }

            SmsManager simManager = manager.createForSubscriptionId(subscriptionId);
            java.util.ArrayList<String> parts = simManager.divideMessage(message);
            if (parts.size() == 1) {
                simManager.sendTextMessage(phoneNumber, null, message, null, null);
            } else {
                simManager.sendMultipartTextMessage(phoneNumber, null, parts, null, null);
            }

            JSObject result = new JSObject();
            result.put("submitted", true);
            call.resolve(result);
        } catch (SecurityException exception) {
            call.reject("Android denied permission to send this SMS.", exception);
        } catch (Exception exception) {
            call.reject("Android could not submit the SMS.", exception);
        }
    }

    private void resolveGranted(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", true);
        call.resolve(result);
    }
}
