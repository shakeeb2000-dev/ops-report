plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/*
 * The web app in ../../www is the single source of truth. Rather than keeping
 * a second copy under src/main/assets, it is synced into a generated assets
 * directory at build time.
 */
val webAppSource = rootProject.file("../www")

val syncWebApp = tasks.register<Sync>("syncWebApp") {
    description = "Copies the offline web app into the APK's assets."
    from(webAppSource)
    into(layout.buildDirectory.dir("generated/webassets/www"))
}

android {
    namespace = "au.ops.dailyreport"
    compileSdk = 34

    defaultConfig {
        applicationId = "au.ops.dailyreport"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    sourceSets {
        getByName("main") {
            assets.srcDir(layout.buildDirectory.dir("generated/webassets"))
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = false
            // Signed with the debug key so `assembleRelease` also produces an
            // installable APK without needing a keystore in CI.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module")
    }
}

tasks.named("preBuild") {
    dependsOn(syncWebApp)
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.0")
}
