package business.munch.app;

import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.libraries.identity.googleid.GetGoogleIdOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;

@CapacitorPlugin(name = "MunchGoogleSignIn")
public class MunchGoogleSignInPlugin extends Plugin {
    @PluginMethod
    public void signIn(PluginCall call) {
        String webClientId = call.getString("webClientId");
        String nonce = call.getString("nonce");
        if (webClientId == null || webClientId.isBlank() || nonce == null || nonce.isBlank()) {
            call.reject("Google sign-in is not configured");
            return;
        }

        GetGoogleIdOption googleIdOption = new GetGoogleIdOption.Builder()
            .setServerClientId(webClientId)
            .setFilterByAuthorizedAccounts(false)
            .setAutoSelectEnabled(false)
            .setNonce(nonce)
            .build();
        GetCredentialRequest request = new GetCredentialRequest.Builder()
            .addCredentialOption(googleIdOption)
            .build();

        CredentialManager manager = CredentialManager.create(getActivity());
        manager.getCredentialAsync(
            getActivity(),
            request,
            null,
            ContextCompat.getMainExecutor(getActivity()),
            new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                @Override
                public void onResult(GetCredentialResponse response) {
                    Credential credential = response.getCredential();
                    if (!(credential instanceof CustomCredential)) {
                        call.reject("Google did not return an ID token");
                        return;
                    }

                    CustomCredential customCredential = (CustomCredential) credential;
                    if (!GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(
                        customCredential.getType()
                    )) {
                        call.reject("Google did not return an ID token");
                        return;
                    }

                    try {
                        GoogleIdTokenCredential googleCredential =
                            GoogleIdTokenCredential.createFrom(customCredential.getData());
                        JSObject result = new JSObject();
                        result.put("idToken", googleCredential.getIdToken());
                        call.resolve(result);
                    } catch (RuntimeException error) {
                        call.reject("Google returned an invalid ID token", error);
                    }
                }

                @Override
                public void onError(GetCredentialException error) {
                    call.reject("Google sign-in was cancelled or could not be completed");
                }
            }
        );
    }
}
