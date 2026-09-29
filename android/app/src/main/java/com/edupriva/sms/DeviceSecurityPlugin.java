package com.edupriva.sms;

import android.content.ContentValues;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

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
import java.security.KeyStore;
import java.util.concurrent.Executor;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "DeviceSecurity")
public class DeviceSecurityPlugin extends Plugin {
    private static final String KEY_ALIAS = "edupriva_biometric_credentials";
    private static final String PREFS_NAME = "edupriva_secure_login";
    private static final String PREF_CREDENTIALS = "encrypted_credentials";
    private static final String PREF_IV = "credentials_iv";
    private static final int AUTHENTICATORS = BiometricManager.Authenticators.BIOMETRIC_WEAK;

    @PluginMethod
    public void getBiometricStatus(PluginCall call) {
        boolean available = BiometricManager.from(getContext()).canAuthenticate(AUTHENTICATORS)
            == BiometricManager.BIOMETRIC_SUCCESS;
        boolean enabled = getPreferences().contains(PREF_CREDENTIALS)
            && getPreferences().contains(PREF_IV);
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
                    try {
                        SharedPreferences preferences = getPreferences();
                        if (preferences.contains(PREF_CREDENTIALS) && preferences.contains(PREF_IV)) {
                            String plaintext = decryptCredentials(
                                preferences.getString(PREF_CREDENTIALS, ""),
                                preferences.getString(PREF_IV, "")
                            );
                            String[] credentials = plaintext.split("\\n", 2);
                            if (credentials.length == 2) {
                                response.put("email", credentials[0]);
                                response.put("password", credentials[1]);
                            }
                        }
                        call.resolve(response);
                    } catch (Exception exception) {
                        call.reject("Could not read the encrypted sign-in details.", exception);
                    }
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
    public void saveCredentials(PluginCall call) {
        String email = call.getString("email");
        String password = call.getString("password");
        if (email == null || email.trim().isEmpty() || password == null || password.isEmpty()) {
            call.reject("A valid email and password are required.");
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateEncryptionKey());
            byte[] encrypted = cipher.doFinal((email + "\n" + password).getBytes(StandardCharsets.UTF_8));
            boolean saved = getPreferences().edit()
                .putString(PREF_CREDENTIALS, Base64.encodeToString(encrypted, Base64.NO_WRAP))
                .putString(PREF_IV, Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
                .commit();
            if (!saved) {
                call.reject("Could not securely save biometric sign-in details.");
                return;
            }
            call.resolve();
        } catch (Exception exception) {
            call.reject("Could not securely save biometric sign-in details.", exception);
        }
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
            Uri savedUri;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, safeFilename);
                values.put(MediaStore.MediaColumns.MIME_TYPE, "application/pdf");
                values.put(MediaStore.MediaColumns.RELATIVE_PATH,
                    Environment.DIRECTORY_DOWNLOADS + "/EduPriva");
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
                getContext().getContentResolver().update(uri, ready, null, null);
                savedUri = uri;
            } else {
                File directory = getContext().getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS);
                if (directory == null) throw new IllegalStateException("App document storage is unavailable.");
                File file = new File(directory, safeFilename);
                try (FileOutputStream output = new FileOutputStream(file)) {
                    output.write(pdfBytes);
                }
                savedUri = Uri.fromFile(file);
            }

            JSObject result = new JSObject();
            result.put("uri", savedUri.toString());
            result.put("filename", safeFilename);
            call.resolve(result);
        } catch (Exception exception) {
            call.reject("Could not save the PDF to this device.", exception);
        }
    }

    private SharedPreferences getPreferences() {
        return getContext().getSharedPreferences(PREFS_NAME, 0);
    }

    private SecretKey getOrCreateEncryptionKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        java.security.Key existing = keyStore.getKey(KEY_ALIAS, null);
        if (existing instanceof SecretKey) return (SecretKey) existing;

        KeyGenerator generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build());
        return generator.generateKey();
    }

    private String decryptCredentials(String encodedCiphertext, String encodedIv) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateEncryptionKey(),
            new GCMParameterSpec(128, Base64.decode(encodedIv, Base64.DEFAULT)));
        byte[] plaintext = cipher.doFinal(Base64.decode(encodedCiphertext, Base64.DEFAULT));
        return new String(plaintext, StandardCharsets.UTF_8);
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
