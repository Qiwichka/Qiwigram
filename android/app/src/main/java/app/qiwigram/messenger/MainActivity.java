package app.qiwigram.messenger;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        /* Свой плагин регистрируется до super: мост поднимается там, и
           опоздавший плагин в него уже не попадёт. */
        registerPlugin(WatchPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
