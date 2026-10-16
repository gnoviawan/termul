use std::future::Future;
use std::time::Duration;

pub(crate) const EXIT_CLEANUP_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) async fn run_exit_cleanup<P, T>(preserve: P, teardown: T, timeout: Duration)
where
    P: Future<Output = ()> + Send + 'static,
    T: Future<Output = ()> + Send + 'static,
{
    run_bounded(
        async move {
            preserve.await;
            teardown.await;
        },
        timeout,
    )
    .await;
}

/// Run `cleanup` and give up on it after `timeout`, so the caller always gets
/// to exit or relaunch.
async fn run_bounded<F>(cleanup: F, timeout: Duration)
where
    F: Future<Output = ()> + Send + 'static,
{
    // Its own task, so the deadline still fires when a teardown step blocks
    // its worker thread instead of awaiting.
    let mut task = tokio::spawn(cleanup);
    match tokio::time::timeout(timeout, &mut task).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => log::error!("[exit] cleanup task failed: {error}"),
        Err(_) => {
            // Stops it at its next await, so it cannot keep tearing down
            // while a relaunched instance starts.
            task.abort();
            log::error!(
                "[exit] cleanup still running after {}s; exiting without it",
                timeout.as_secs()
            );
        }
    }
}

#[cfg(test)]
#[path = "exit_cleanup_tests.rs"]
mod tests;
