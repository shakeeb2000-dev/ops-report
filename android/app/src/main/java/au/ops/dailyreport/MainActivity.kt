package au.ops.dailyreport

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import java.io.File

/**
 * Thin native shell around the offline web app in assets/www.
 *
 * It exists to do the three things a plain browser tab cannot do well on a
 * phone: pick or take a photo from a file input, hand a generated PDF to the
 * Android share sheet, and keep running without a browser chrome in the way.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    companion object {
        private const val REQ_FILE_CHOOSER = 1001
        private const val START_URL = "file:///android_asset/www/index.html"
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true          // IndexedDB / localStorage
                databaseEnabled = true
                allowFileAccess = false           // assets still load fine
                allowContentAccess = false
                mediaPlaybackRequiresUserGesture = false
                loadWithOverviewMode = true
                useWideViewPort = true
                textZoom = 100                    // ignore system font scaling
            }
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView?,
                    request: android.webkit.WebResourceRequest?
                ): Boolean {
                    val url = request?.url ?: return false
                    // Keep app pages in the WebView; send anything external out.
                    if (url.scheme == "file") return false
                    startActivity(Intent(Intent.ACTION_VIEW, url))
                    return true
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(
                    view: WebView?,
                    callback: ValueCallback<Array<Uri>>?,
                    params: FileChooserParams?
                ): Boolean {
                    fileCallback?.onReceiveValue(null)
                    fileCallback = callback
                    return try {
                        val intent = params?.createIntent()
                        if (intent == null) {
                            fileCallback = null
                            false
                        } else {
                            // createIntent() honours accept="image/*" and the
                            // multiple attribute, and the system picker offers
                            // the camera, so no CAMERA permission is needed.
                            startActivityForResult(
                                Intent.createChooser(intent, "Add photo"),
                                REQ_FILE_CHOOSER
                            )
                            true
                        }
                    } catch (e: Exception) {
                        fileCallback?.onReceiveValue(null)
                        fileCallback = null
                        false
                    }
                }
            }
            addJavascriptInterface(AndroidBridge(), "AndroidBridge")
        }

        setContentView(webView)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })

        if (savedInstanceState == null) webView.loadUrl(START_URL)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQ_FILE_CHOOSER) {
            val cb = fileCallback
            fileCallback = null
            if (cb == null) return
            if (resultCode != Activity.RESULT_OK || data == null) {
                cb.onReceiveValue(null)
                return
            }
            cb.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            return
        }
        super.onActivityResult(requestCode, resultCode, data)
    }

    /** Exposed to the web app as window.AndroidBridge. */
    inner class AndroidBridge {

        /**
         * Receives the finished PDF as base64, writes it to the app's shared
         * cache directory and opens the system share sheet so the operator can
         * pick WhatsApp (or email, Drive, anything else).
         */
        @JavascriptInterface
        fun sharePdf(base64: String, filename: String) {
            runOnUiThread {
                try {
                    val bytes = Base64.decode(base64, Base64.DEFAULT)
                    val dir = File(cacheDir, "shared").apply { mkdirs() }
                    // Only keep the latest few exports around.
                    dir.listFiles()?.sortedBy { it.lastModified() }?.dropLast(4)
                        ?.forEach { it.delete() }

                    val safeName = filename.replace(Regex("[^A-Za-z0-9._-]"), "_")
                    val file = File(dir, safeName)
                    file.writeBytes(bytes)

                    val uri = FileProvider.getUriForFile(
                        this@MainActivity,
                        "$packageName.fileprovider",
                        file
                    )

                    val send = Intent(Intent.ACTION_SEND).apply {
                        type = "application/pdf"
                        putExtra(Intent.EXTRA_STREAM, uri)
                        putExtra(Intent.EXTRA_SUBJECT, safeName.removeSuffix(".pdf"))
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    startActivity(Intent.createChooser(send, "Send report"))
                } catch (e: Exception) {
                    toastJs("Could not share the PDF: ${e.message}")
                }
            }
        }

        /** Lets the web layer confirm which shell it is running inside. */
        @JavascriptInterface
        fun platform(): String = "android-${Build.VERSION.SDK_INT}"
    }

    private fun toastJs(message: String) {
        val escaped = message.replace("\\", "\\\\").replace("'", "\\'")
        webView.evaluateJavascript("window.toast && window.toast('$escaped');", null)
    }
}
