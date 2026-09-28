-- student_db schema and seed data.

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";
SET NAMES utf8mb4;

DROP TABLE IF EXISTS `students`;

CREATE TABLE `students` (
  `id` int NOT NULL,
  `name` varchar(100) NOT NULL,
  `course` varchar(50) NOT NULL,
  `year_level` int NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Ids are a 2-digit year + a per-year counter, so these two were added in 2026.
-- The app assigns ids, so there is no AUTO_INCREMENT here.
INSERT INTO `students` (`id`, `name`, `course`, `year_level`) VALUES
(26000001, 'Juan Dela Cruz', 'BSIT', 2),
(26000002, 'Maria Santos', 'BSCS', 3);

COMMIT;
