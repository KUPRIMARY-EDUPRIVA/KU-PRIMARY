package com.edupriva.sms;

import android.content.ContentValues;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.widget.Toast;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executor;

@CapacitorPlugin(name = "DeviceSecurity")
public class DeviceSecurityPlugin extends Plugin {
    private static final String PREFS_NAME = "edupriva_secure_login";
    private static final String PREF_BIOMETRIC_UNLOCK = "biometric_unlock_enabled";
    private static final String PREF_CREDENTIALS = "encrypted_credentials";
    private static final String PREF_IV = "credentials_iv";
    private static final int AUTHENTICATORS = BiometricManager.Authenticators.BIOMETRIC_WEAK;

    @PluginMethod
    public void getBiometricStatus(PluginCall call) {
        boolean available = BiometricManager.from(getContext()).canAuthenticate(AUTHENTICATORS)
            == BiometricManager.BIOMETRIC_SUCCESS;
        boolean enabled = getPreferences().getBoolean(PREF_BIOMETRIC_UNLOCK, false);
        JSObject result = new JSObject();
        result.put("available", available);
        result.put("enabled", available && enabled);
        call.resolve(result);
    }

    @PluginMethod
    public void authenticate(PluginCall call) {
        int availability = BiometricManager.from(getContext()).canAuthenticate(AUTHENTICATORS);
        if (availability != BiometricManager.BIOMETRIC_SUCCESS) {
            call.reject(biometricStatusMessage(availability));
            return;
        }

        Executor executor = ContextCompat.getMainExecutor(getContext());
        BiometricPrompt prompt = new BiometricPrompt(getActivity(), executor,
            new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                    JSObject response = new JSObject();
                    response.put("authenticated", true);
                    call.resolve(response);
                }

                @Override
                public void onAuthenticationError(int errorCode, CharSequence errorString) {
                    call.reject(errorString.toString());
                }

                @Override
                public void onAuthenticationFailed() {
                    // The prompt remains open so the user can retry.
                }
            });
        BiometricPrompt.PromptInfo promptInfo = new BiometricPrompt.PromptInfo.Builder()
            .setTitle("Sign in to EduPriva")
            .setSubtitle("Verify your identity to continue")
            .setNegativeButtonText("Cancel")
            .build();
        prompt.authenticate(promptInfo);
    }

    @PluginMethod
    public void enableBiometricUnlock(PluginCall call) {
        boolean saved = getPreferences().edit()
            .remove(PREF_CREDENTIALS)
            .remove(PREF_IV)
            .putBoolean(PREF_BIOMETRIC_UNLOCK, true)
            .commit();
        if (!saved) {
            call.reject("Could not enable biometric unlock.");
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void savePdf(PluginCall call) {
        String filename = call.getString("filename");
        String encodedPdf = call.getString("base64");
        if (filename == null || encodedPdf == null || encodedPdf.isEmpty()) {
            call.reject("A PDF filename and file content are required.");
            return;
        }
        String safeFilename = filename.replaceAll("[^A-Za-z0-9._-]", "_");
        if (!safeFilename.toLowerCase().endsWith(".pdf")) safeFilename += ".pdf";

        try {
            byte[] pdfBytes = Base64.decode(encodedPdf, Base64.DEFAULT);
            if (pdfBytes.length < 5 || !new String(pdfBytes, 0, 5, StandardCharsets.US_ASCII).equals("%PDF-")) {
                throw new IllegalArgumentException("The generated file is not a valid PDF.");
            }
            Uri savedUri;
            String location;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, safeFilename);
                values.put(MediaStore.MediaColumns.MIME_TYPE, "application/pdf");
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                Uri uri = getContext().getContentResolver().insert(
                    MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) throw new IllegalStateException("Android did not create the download file.");
                try (OutputStream output = getContext().getContentResolver().openOutputStream(uri)) {
                    if (output == null) throw new IllegalStateException("Could not open the downloaded PDF.");
                    output.write(pdfBytes);
                } catch (Exception exception) {
                    getContext().getContentResolver().delete(uri, null, null);
                    throw exception;
                }
                ContentValues ready = new ContentValues();
                ready.put(MediaStore.MediaColumns.IS_PENDING, 0);
                if (getContext().getContentResolver().update(uri, ready, null, null) != 1) {
                    getContext().getContentResolver().delete(uri, null, null);
                    throw new IllegalStateException("Android could not publish the PDF in Downloads.");
                }
                savedUri = uri;
                location = "Downloads/" + safeFilename;
            } else {
                File directory = getContext().getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS);
                if (directory == null) throw new IllegalStateException("App document storage is unavailable.");
                File file = new File(directory, safeFilename);
                try (FileOutputStream output = new FileOutputStream(file)) {
                    output.write(pdfBytes);
                    output.getFD().sync();
                }
                if (!file.isFile() || file.length() != pdfBytes.length) {
                    throw new IllegalStateException("Android could not finish saving the PDF.");
                }
                savedUri = Uri.fromFile(file);
                location = "Documents/" + safeFilename + " (app storage)";
            }

            JSObject result = new JSObject();
            result.put("uri", savedUri.toString());
            result.put("filename", safeFilename);
            result.put("location", location);
            call.resolve(result);
            getActivity().runOnUiThread(() ->
                Toast.makeText(getContext(), "PDF saved to " + location, Toast.LENGTH_LONG).show());
        } catch (Exception exception) {
            call.reject("Could not save the PDF to this device.", exception);
        }
    }

    private SharedPreferences getPreferences() {
        return getContext().getSharedPreferences(PREFS_NAME, 0);
    }

    private String biometricStatusMessage(int status) {
        switch (status) {
            case BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE:
                return "This device does not have biometric hardware.";
            case BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE:
                return "Biometric hardware is currently unavailable.";
            case BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED:
                return "Set up a fingerprint or other biometric in your device settings first.";
            default:
                return "Biometric authentication is unavailable on this device.";
        }
    }
}
