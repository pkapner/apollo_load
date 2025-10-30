package com.example

import com.apollographql.apollo.ApolloClient
import com.apollographql.apollo.api.Operation
import com.apollographql.apollo.api.ResponseField
import com.apollographql.apollo.cache.normalized.CacheKey
import com.apollographql.apollo.cache.normalized.CacheKeyResolver
import com.apollographql.apollo.cache.normalized.lru.EvictionPolicy
import com.apollographql.apollo.cache.normalized.lru.LruNormalizedCacheFactory
import com.apollographql.apollo.coroutines.await
import com.apollographql.apollo.exception.ApolloException
import com.apollographql.apollo.fetcher.ApolloResponseFetchers
import com.example.graphql.HelloQuery
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.time.Duration
import java.time.Instant
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicIntegerArray
import java.util.concurrent.atomic.AtomicLong

private data class StressConfig(
    val endpoint: String,
    val concurrency: Int,
    val iterations: Int,
    val metricsEndpoint: String?,
    val loadScale: Int,
    val eventLimit: Int,
    val seedBase: Int,
    val seedWindow: Int,
) {
    companion object {
        private fun lookup(key: String): String? {
            val env = System.getenv(key)?.takeIf { it.isNotBlank() }
            if (env != null) return env
            return System.getProperty(key)?.takeIf { it.isNotBlank() }
        }

        fun fromEnv(): StressConfig {
            val endpoint = lookup("APOLLO_ENDPOINT") ?: "http://localhost:4000/graphql"
            val concurrency = (lookup("APOLLO_CONCURRENCY")?.toIntOrNull() ?: 16).coerceAtLeast(1)
            val baseIterations = (lookup("APOLLO_ITERATIONS")?.toIntOrNull() ?: 200).coerceAtLeast(1)
            val loadScale = (lookup("APOLLO_LOAD_SCALE")?.toIntOrNull() ?: 1_000).coerceAtLeast(1)
            val iterations = baseIterations * loadScale
            val metricsEndpoint = lookup("APOLLO_METRICS_URL")
            val seededEventLimit = lookup("APOLLO_EVENT_LIMIT")?.toIntOrNull()
            val computedEventLimit = (seededEventLimit ?: (50 * loadScale))
                .coerceAtLeast(25)
                .coerceAtMost(5_000)
            val seedBase = lookup("APOLLO_SEED_BASE")?.toIntOrNull() ?: 1_337
            val seedWindow = (lookup("APOLLO_SEED_WINDOW")?.toIntOrNull() ?: 64).coerceAtLeast(1)
            return StressConfig(
                endpoint = endpoint,
                concurrency = concurrency,
                iterations = iterations,
                metricsEndpoint = metricsEndpoint,
                loadScale = loadScale,
                eventLimit = computedEventLimit,
                seedBase = seedBase,
                seedWindow = seedWindow,
            )
        }
    }
}

fun main() = runBlocking<Unit>(Dispatchers.Default) {
    val config = StressConfig.fromEnv()
    val totalRequests = config.iterations * config.concurrency
    println(
        "Starting Apollo stress run -> endpoint=${config.endpoint}, " +
            "concurrency=${config.concurrency}, iterationsPerWorker=${config.iterations}, " +
            "totalRequests=$totalRequests (loadScale=${config.loadScale}, eventLimit=${config.eventLimit})",
    )

    val httpClient = OkHttpClient.Builder()
        .retryOnConnectionFailure(true)
        .build()

    val cacheResolver = object : CacheKeyResolver() {
        override fun fromFieldArguments(field: ResponseField, variables: Operation.Variables): CacheKey {
            return CacheKey.NO_KEY
        }

        override fun fromFieldRecordSet(field: ResponseField, recordSet: Map<String, Any>): CacheKey {
            val id = recordSet["id"] as? String ?: return CacheKey.NO_KEY
            return CacheKey.from(id)
        }
    }
    val cacheFactory = LruNormalizedCacheFactory(
        EvictionPolicy.builder()
            .maxSizeBytes(256L * 1024 * 1024)
            .build(),
    )

    val client = ApolloClient.builder()
        .serverUrl(config.endpoint)
        .okHttpClient(httpClient)
        .normalizedCache(cacheFactory, cacheResolver)
        .build()

    val completed = AtomicInteger(0)
    val errors = AtomicInteger(0)
    val perWorkerProgress = AtomicIntegerArray(config.concurrency)
    val cacheWrites = AtomicInteger(0)
    val cacheReadHits = AtomicInteger(0)
    val cacheReadMisses = AtomicInteger(0)
    val processedBytes = AtomicLong(0)
    val start = Instant.now()
    val metricsReporter = MetricsReporter(
        httpClient = httpClient,
        metricsEndpoint = config.metricsEndpoint,
        totalRequests = totalRequests,
        concurrency = config.concurrency,
        iterations = config.iterations,
        startedAt = start,
        loadScale = config.loadScale,
        eventLimit = config.eventLimit,
    )
    metricsReporter.report(
        completed = 0,
        errors = 0,
        workerProgress = perWorkerProgress.snapshot(),
        cacheWrites = cacheWrites.get(),
        cacheHits = cacheReadHits.get(),
        cacheMisses = cacheReadMisses.get(),
        bytesProcessed = processedBytes.get(),
    )

    val jobs = mutableListOf<Job>()
    repeat(config.concurrency) { workerId ->
        jobs += launch {
            repeat(config.iterations) { iteration ->
                val limitJitter = (iteration + workerId) % 5
                val requestLimit = (config.eventLimit - limitJitter * 3).coerceAtLeast(25)
                val windowIndex = iteration % config.seedWindow
                val epoch = iteration / config.seedWindow
                val seed = config.seedBase + windowIndex + (workerId * config.seedWindow) + epoch * 131
                val baseQuery = HelloQuery(limit = requestLimit, seed = seed)
                try {
                    val networkResult = client.query(baseQuery)
                        .toBuilder()
                        .responseFetcher(ApolloResponseFetchers.NETWORK_ONLY)
                        .build()
                        .await()
                    if (networkResult.hasErrors()) {
                        errors.incrementAndGet()
                        println("worker=$workerId iteration=$iteration -> GraphQL errors: ${networkResult.errors}")
                    } else {
                        cacheWrites.incrementAndGet()
                        processedBytes.addAndGet(
                            accumulateTextPayloadBytes(networkResult.data?.events),
                        )
                        try {
                            val cacheResult = client.query(baseQuery)
                                .toBuilder()
                                .responseFetcher(ApolloResponseFetchers.CACHE_ONLY)
                                .build()
                                .await()
                            if (cacheResult.hasErrors()) {
                                cacheReadMisses.incrementAndGet()
                                errors.incrementAndGet()
                                println("worker=$workerId iteration=$iteration -> cache GraphQL errors: ${cacheResult.errors}")
                            } else if (cacheResult.data != null) {
                                cacheReadHits.incrementAndGet()
                                processedBytes.addAndGet(
                                    accumulateTextPayloadBytes(cacheResult.data?.events),
                                )
                            } else {
                                cacheReadMisses.incrementAndGet()
                            }
                        } catch (cacheException: ApolloException) {
                            cacheReadMisses.incrementAndGet()
                            errors.incrementAndGet()
                            println("worker=$workerId iteration=$iteration -> cache-only Apollo exception: ${cacheException.message}")
                        }
                    }
                } catch (exception: ApolloException) {
                    errors.incrementAndGet()
                    println("worker=$workerId iteration=$iteration -> Apollo exception: ${exception.message}")
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (throwable: Throwable) {
                    errors.incrementAndGet()
                    println("worker=$workerId iteration=$iteration -> unexpected failure: ${throwable.message}")
                } finally {
                    perWorkerProgress.set(workerId, iteration + 1)
                    if ((iteration + 1) % 100 == 0 || iteration + 1 == config.iterations) {
                        println("worker=$workerId progress=${iteration + 1}/${config.iterations}")
                    }
                    val done = completed.incrementAndGet()
                    if (done % 100 == 0 || done == totalRequests) {
                        println("Progress: $done/$totalRequests requests completed (${errors.get()} errors)")
                    }
                    if (done % 20 == 0 || done == totalRequests) {
                        metricsReporter.report(
                            completed = done,
                            errors = errors.get(),
                            workerProgress = perWorkerProgress.snapshot(),
                            cacheWrites = cacheWrites.get(),
                            cacheHits = cacheReadHits.get(),
                            cacheMisses = cacheReadMisses.get(),
                            bytesProcessed = processedBytes.get(),
                        )
                    }
                }
            }
        }
    }

    jobs.forEach { it.join() }

    val elapsed = Duration.between(start, Instant.now())
    val workerSummary = buildString {
        append("workerProgress=[")
        (0 until config.concurrency).joinTo(this) { workerId ->
            val count = perWorkerProgress.get(workerId)
            "worker $workerId=$count"
        }
        append("]")
    }
    println("Finished stress run in ${elapsed.toMillis()}ms with ${completed.get()} requests and ${errors.get()} errors.")
    println(workerSummary)
    println(
        "Cache writes=${cacheWrites.get()}, cacheHits=${cacheReadHits.get()}, " +
            "cacheMisses=${cacheReadMisses.get()}, processedBytes=${processedBytes.get()}",
    )
}

private fun accumulateTextPayloadBytes(events: List<HelloQuery.Event?>?): Long {
    var total = 0L
    events?.forEach { event ->
        val payload = event?.payload?.asTextPayload
        if (payload != null) {
            total += payload.message.length.toLong()
            total += payload.severity.toLong()
        }
    }
    return total
}

private fun AtomicIntegerArray.snapshot(): IntArray =
    IntArray(length()) { index -> get(index) }

private class MetricsReporter(
    private val httpClient: OkHttpClient,
    metricsEndpoint: String?,
    private val totalRequests: Int,
    private val concurrency: Int,
    private val iterations: Int,
    private val startedAt: Instant,
    private val loadScale: Int,
    private val eventLimit: Int,
) {
    private val endpoint = metricsEndpoint?.toHttpUrlOrNull()
    private val mediaType = "application/json".toMediaType()
    private val warned = AtomicBoolean(false)

    fun report(
        completed: Int,
        errors: Int,
        workerProgress: IntArray,
        cacheWrites: Int,
        cacheHits: Int,
        cacheMisses: Int,
        bytesProcessed: Long,
    ) {
        val url = endpoint ?: return
        val now = Instant.now()
        val payload = buildString {
            append('{')
            append("\"timestamp\":").append(now.toEpochMilli()).append(',')
            append("\"startedAt\":").append(startedAt.toEpochMilli()).append(',')
            append("\"completed\":").append(completed).append(',')
            append("\"total\":").append(totalRequests).append(',')
            append("\"errors\":").append(errors).append(',')
            append("\"concurrency\":").append(concurrency).append(',')
            append("\"iterations\":").append(iterations).append(',')
            append("\"loadScale\":").append(loadScale).append(',')
            append("\"eventLimit\":").append(eventLimit).append(',')
            append("\"cacheWrites\":").append(cacheWrites).append(',')
            append("\"cacheHits\":").append(cacheHits).append(',')
            append("\"cacheMisses\":").append(cacheMisses).append(',')
            append("\"bytesProcessed\":").append(bytesProcessed).append(',')
            append("\"workerProgress\":[")
            if (workerProgress.isNotEmpty()) {
                workerProgress.joinTo(this, separator = ",")
            }
            append("]")
            append('}')
        }

        val request = Request.Builder()
            .url(url)
            .post(payload.toRequestBody(mediaType))
            .build()

        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (warned.compareAndSet(false, true)) {
                    println("MetricsReporter failed to publish metrics: ${e.message}")
                }
            }

            override fun onResponse(call: Call, response: Response) {
                response.close()
            }
        })
    }
}
