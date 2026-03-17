use std::fs::File;
use std::path::Path;

use chrono::Local;
use tracing_subscriber::{fmt, EnvFilter};

pub fn init_logging(log_dir: &Path) -> Result<(), std::io::Error> {
    let log_file = log_dir.join(format!("app-{}.log", Local::now().format("%Y%m%d")));
    let file = File::options().create(true).append(true).open(log_file)?;
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let subscriber = fmt().with_env_filter(filter).with_writer(file).finish();
    let _ = tracing::subscriber::set_global_default(subscriber);
    Ok(())
}

