import org.gradle.api.tasks.JavaExec
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

plugins {
    kotlin("jvm") version "1.9.23"
    application
    id("com.apollographql.apollo") version "2.5.14"
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("com.apollographql.apollo:apollo-runtime:2.5.14")
    implementation("com.apollographql.apollo:apollo-coroutines-support:2.5.14")
    implementation("com.apollographql.apollo:apollo-normalized-cache:2.5.14")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.1")
    testImplementation(kotlin("test"))
}

application {
    mainClass.set("com.example.MainKt")
}

tasks.withType<KotlinCompile>().configureEach {
    kotlinOptions {
        jvmTarget = "17"
        freeCompilerArgs = freeCompilerArgs + "-Xjsr305=strict"
    }
}

apollo {
    generateKotlinModels.set(true)
    service("mismatched") {
        packageName.set("com.example.graphql")
        schemaPath.set("com/example/schema_mismatched.graphqls")
    }
}

val apolloConfigKeys = listOf(
    "APOLLO_ENDPOINT",
    "APOLLO_CONCURRENCY",
    "APOLLO_ITERATIONS",
    "APOLLO_METRICS_URL",
    "APOLLO_LOAD_SCALE",
    "APOLLO_EVENT_LIMIT",
    "APOLLO_SEED_BASE",
    "APOLLO_SEED_WINDOW",
)

tasks.named<JavaExec>("run").configure {
    apolloConfigKeys.forEach { key ->
        (project.findProperty(key) as? String)?.let { value ->
            environment(key, value)
            systemProperty(key, value)
        }
    }
}
