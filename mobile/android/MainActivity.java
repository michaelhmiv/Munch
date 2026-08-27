package business.munch.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MunchSecureSessionPlugin.class);
        registerPlugin(MunchPlayBillingPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
