package com.edupriva.sms;

import com.getcapacitor.BridgeActivity;
import android.view.WindowManager;

public class MainActivity extends BridgeActivity {
    private void protectWindow() {
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE
        );
    }

    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        protectWindow();
        registerPlugin(DeviceSmsPlugin.class);
        registerPlugin(DeviceSecurityPlugin.class);
        super.onCreate(savedInstanceState);
        protectWindow();
    }

    @Override
    public void onResume() {
        super.onResume();
        protectWindow();
    }
}
