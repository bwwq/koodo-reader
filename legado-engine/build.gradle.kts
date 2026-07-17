import com.github.jengelman.gradle.plugins.shadow.tasks.ShadowJar
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

plugins {
    kotlin("jvm") version "1.5.31"
    application
    id("com.github.johnrengelman.shadow") version "7.0.0"
}

group = "gs.ouo.rd.koodo"
version = "0.6.0"

repositories { mavenCentral() }

val vertxVersion = "4.2.1"

dependencies {
    implementation(platform("io.vertx:vertx-stack-depchain:$vertxVersion"))
    implementation("io.vertx:vertx-web")
    implementation("io.vertx:vertx-lang-kotlin-coroutines")
    implementation("io.vertx:vertx-lang-kotlin")
    implementation(kotlin("stdlib-jdk8"))
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.5.2")
    implementation("com.google.code.gson:gson:2.8.9")
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin:2.13.5")
    implementation("io.github.microutils:kotlin-logging:3.0.0")
    implementation("org.slf4j:slf4j-simple:2.0.12")
    implementation("uk.org.lidalia:sysout-over-slf4j:1.0.2")
    implementation("com.google.guava:guava:31.1-jre")
    implementation("com.squareup.okhttp3:okhttp:4.9.3")
    implementation("com.squareup.okhttp3:logging-interceptor:4.9.3")
    implementation("com.squareup.retrofit2:retrofit:2.9.0")
    implementation("com.julienviet:retrofit-vertx:1.1.3")
    implementation(files("../vendor/reader-legado/src/lib/rhino-1.7.13-1.jar"))
    implementation(files("../vendor/reader-legado/src/lib/xmlpull-1.1.3.1.jar"))
    implementation("org.jsoup:jsoup:1.15.4")
    implementation("cn.wanghaomiao:JsoupXpath:2.5.3")
    implementation("com.jayway.jsonpath:json-path:2.7.0")
    implementation("cn.hutool:hutool-crypto:5.8.25")
    testImplementation("junit:junit:4.13.2")
}

sourceSets {
    main {
        java.srcDirs("src/main/kotlin", "../vendor/reader-legado/src/main/java")
        java.exclude("io/legado/app/help/http/HttpHelper.kt")
        resources.srcDirs("src/main/resources", "../vendor/reader-legado/src/main/resources")
    }
}

application { mainClass.set("gs.ouo.rd.koodo.legado.EngineMainKt") }

tasks.withType<KotlinCompile> {
    kotlinOptions.jvmTarget = "1.8"
}

java {
    sourceCompatibility = JavaVersion.VERSION_1_8
    targetCompatibility = JavaVersion.VERSION_1_8
}

tasks.withType<ShadowJar> {
    archiveFileName.set("koodo-legado-engine.jar")
    mergeServiceFiles()
}
