package io.legado.app.help.http

import io.legado.app.model.DebugLog
import okhttp3.ConnectionSpec
import okhttp3.Dns
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

private val proxyClientCache = ConcurrentHashMap<String, OkHttpClient>()

private val privateHostAllowlist: Set<String> by lazy {
    (System.getenv("LEGADO_ALLOWED_PRIVATE_HOSTS") ?: "")
        .split(',')
        .map { it.trim().lowercase() }
        .filter { it.isNotEmpty() }
        .toSet()
}

private fun isBlockedAddress(address: InetAddress): Boolean {
    if (address.isAnyLocalAddress || address.isLoopbackAddress ||
        address.isLinkLocalAddress || address.isSiteLocalAddress ||
        address.isMulticastAddress
    ) return true
    val bytes = address.address.map { it.toInt() and 0xff }
    if (bytes.size == 4) {
        if (bytes[0] == 0 || bytes[0] == 127) return true
        if (bytes[0] == 100 && bytes[1] in 64..127) return true
        if (bytes[0] >= 224) return true
    }
    if (bytes.size == 16) {
        if ((bytes[0] and 0xfe) == 0xfc) return true
        if (bytes[0] == 0xfe && (bytes[1] and 0xc0) == 0x80) return true
    }
    return false
}

private object SafeDns : Dns {
    override fun lookup(hostname: String): List<InetAddress> {
        val normalized = hostname.trimEnd('.').lowercase()
        if (normalized == "localhost" || normalized.endsWith(".localhost") ||
            normalized.endsWith(".local")
        ) throw UnknownHostException("blocked host")
        val addresses = Dns.SYSTEM.lookup(hostname)
        if (normalized !in privateHostAllowlist && addresses.any(::isBlockedAddress)) {
            throw UnknownHostException("private and special-purpose addresses are blocked")
        }
        return addresses
    }
}

val okHttpClient: OkHttpClient by lazy {
    OkHttpClient.Builder()
        .dns(SafeDns)
        .connectTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .connectionSpecs(
            listOf(
                ConnectionSpec.MODERN_TLS,
                ConnectionSpec.COMPATIBLE_TLS,
                ConnectionSpec.CLEARTEXT
            )
        )
        .followRedirects(true)
        .followSslRedirects(true)
        .addNetworkInterceptor(Interceptor { chain ->
            val request = chain.request()
            if (request.url.scheme != "http" && request.url.scheme != "https") {
                throw IllegalArgumentException("unsupported URL scheme")
            }
            chain.proceed(
                request.newBuilder()
                    .header("Connection", "keep-alive")
                    .header("Cache-Control", "no-cache")
                    .build()
            )
        })
        .build()
}

fun getProxyClient(proxy: String? = null, debugLog: DebugLog? = null): OkHttpClient {
    if (!proxy.isNullOrBlank()) {
        throw IllegalArgumentException("book-source proxies are disabled by server policy")
    }
    if (debugLog == null) return okHttpClient
    return proxyClientCache.computeIfAbsent("debug-${debugLog.hashCode()}") {
        val logger = HttpLoggingInterceptor(debugLog)
        logger.level = HttpLoggingInterceptor.Level.BASIC
        okHttpClient.newBuilder().addNetworkInterceptor(logger).build()
    }
}

